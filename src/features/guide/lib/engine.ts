import type { GuideEvent, GuideReason, LyricLine, Song } from '../../../shared/document'
import { EPS, buildLinePlan, nextPreset, type EntryCandidate, type LinePlan } from './plan'

export interface GuideSink {
  /** Guide starts singing a preset. */
  start?: (event: GuideEvent, position: number, candidate: EntryCandidate) => void
  /** Guide stops the preset that is currently sounding. */
  stop?: (event: GuideEvent, position: number) => void
}

export type GuidePhase = 'idle' | 'listening' | 'pickup' | 'prompting' | 'yielding' | 'ended'

export interface GuideSnapshot {
  phase: GuidePhase
  confirmed: boolean
  activeCandidateId: string | null
  nextCandidate: EntryCandidate | null
  lastEvent: GuideEvent | null
  pass: number
}

/** Sustained, steady voice needed before the guide trusts the singer. */
const CONFIRM_SPAN = 0.18
/** Pitch spread beyond this marks a run as unsteady (noise, scoops). */
const PITCH_SPREAD = 2.4
/** Silence after singing before the guide may offer a re-entry. */
const MISS_GAP = 0.7
/** A scrub this large between animation frames is a jump, not playback. */
const JUMP_FORWARD = 1.2

/** Largest normal step between animation frames; anything larger is a jump. */
const FRAME = 0.055
const AMBIGUOUS_COOLDOWN = 0.6
const YIELD_COOLDOWN = 0.45

const AUDIBLE: GuideEvent['kind'][] = ['pickup', 'cue']

function spread(midi: number[]) {
  let low = Infinity
  let high = -Infinity
  for (const value of midi) {
    if (value < low) low = value
    if (value > high) high = value
  }
  return high - low
}

/**
 * Deterministic guide-vocal state machine.
 *
 * The guide only reacts to evidence it has confirmed — a sustained, steady
 * pitch run — and otherwise falls back to the next preset that can still be
 * played in full. Every audible prompt is recorded as a GuideEvent so review
 * can replay exactly what was sung.
 */
export function createGuideEngine(song: Song, sink: GuideSink = {}) {
  let plan: LinePlan | null = null
  let line: LyricLine | null = null
  let mode: 'idle' | 'take' | 'ended' = 'idle'
  let pass = 0
  let sequence = 0
  let lastPos = -Infinity
  let active: { candidate: EntryCandidate; event: GuideEvent; pickup: boolean; joined: boolean } | null = null
  let done = new Set<number>()
  let skipped = new Set<number>()
  let lastSkippedAt = -Infinity
  let pickupUsed = false
  let confirmed = false
  let voiced: { start: number; last: number; pitches: number[] } | null = null
  let lastVoicedAt: number | null = null
  let lastAckAt = -Infinity
  let lastAmbiguousAt = -Infinity
  const events: GuideEvent[] = []
  const audible: GuideEvent[] = []

  function emit(kind: GuideEvent['kind'], fields: Partial<GuideEvent> & { at: number }): GuideEvent {
    const event: GuideEvent = {
      id: `${line?.id ?? 'line'}:p${pass}:${kind}:${sequence++}`,
      kind,
      pass,
      lineId: line?.id ?? '',
      ...fields,
    }
    events.push(event)
    if (AUDIBLE.includes(kind)) audible.push(event)
    return event
  }

  function noteAmbiguous(at: number, detail: string) {
    if (at - lastAmbiguousAt < AMBIGUOUS_COOLDOWN) return
    lastAmbiguousAt = at
    emit('miss', { at, reason: 'ambiguous', detail })
  }

  function stopCue(position: number, cause: 'yield' | 'completed' | 'reset' | 'end') {
    if (!active) return null
    const cue = active
    const end = Math.max(cue.event.start ?? cue.candidate.start, Math.min(position, cue.candidate.end))
    cue.event.end = end
    active = null
    sink.stop?.(cue.event, position)
    if (cause === 'yield') {
      lastAckAt = position
      emit('yield', {
        at: end, reason: 'yield', candidateId: cue.candidate.id, noteIndex: cue.candidate.noteIndex,
        midi: cue.candidate.midi, start: cue.event.start, variant: cue.candidate.variant,
        detail: '你已经唱上来，导唱让出后面的旋律',
      })
    }
    return cue
  }

  function startCue(candidate: EntryCandidate, position: number) {
    const pickup = !pickupUsed && candidate.id === plan?.pickup?.id
    if (pickup) pickupUsed = true
    const event = emit(pickup ? 'pickup' : 'cue', {
      at: position,
      reason: pickup ? 'start' : 'missed',
      candidateId: candidate.id,
      noteIndex: candidate.noteIndex,
      midi: candidate.midi,
      start: candidate.start,
      end: candidate.end,
      variant: candidate.variant,
    })
    active = { candidate, event, pickup, joined: false }
    done.add(candidate.noteIndex)
    sink.start?.(event, position, candidate)
  }

  function yieldEvidence(time: number, detail: string) {
    if (time - lastAckAt < YIELD_COOLDOWN) return
    lastAckAt = time
    emit('yield', { at: time, reason: 'yield', detail })
  }

  function confirm(time: number) {
    if (!voiced) return
    const first = !confirmed
    confirmed = true
    lastVoicedAt = time
    if (active) {
      if (active.pickup) {
        // Keep the weak-start hint sounding; the melody after it stays yours.
        active.joined = true
        return
      }
      stopCue(time, 'yield')
      return
    }
    if (first) {
      yieldEvidence(time, pickupUsed ? '你已接着唱，导唱退到下一处' : '你按时唱上来，导唱不再出声')
    }
  }

  function observe(time: number, midi: number | null) {
    if (mode !== 'take' || !line) return
    if (time < line.start - 0.5 || time > line.end + 0.5) return
    if (midi === null) {
      if (voiced) {
        if (!confirmed || voiced.start > (lastVoicedAt ?? -Infinity)) {
          noteAmbiguous(voiced.last, '短促冒尖，未确认是歌声')
        }
        voiced = null
      }
      return
    }
    if (!voiced) {
      voiced = { start: time, last: time, pitches: [midi] }
    } else {
      voiced.last = time
      voiced.pitches.push(midi)
      if (spread(voiced.pitches) > PITCH_SPREAD) {
        noteAmbiguous(time, '音高抖动，判不出是歌声')
        voiced = { start: time, last: time, pitches: [midi] }
      }
    }
    lastVoicedAt = time
    if (time - voiced.start >= CONFIRM_SPAN && spread(voiced.pitches) <= PITCH_SPREAD) {
      confirm(time)
    }
  }

  function scan(position: number) {
    if (!plan || !line) return
    const candidate = nextPreset(plan, position, done)
    if (!candidate) return
    // Wake on the frame the preset becomes due, not a little early.
    if (candidate.start > position + FRAME) return
    startCue(candidate, position)
  }

  function reset(position: number, reason: GuideReason) {
    if (mode === 'idle') return
    if (active) stopCue(position, 'reset')
    pass += 1
    sequence = 0
    done = new Set()
    skipped = new Set()
    pickupUsed = false
    confirmed = false
    voiced = null
    lastVoicedAt = null
    lastAckAt = -Infinity
    lastAmbiguousAt = -Infinity
    lastSkippedAt = -Infinity
    lastPos = position
    mode = 'take'
    emit('reset', {
      at: position, reason,
      detail: reason === 'loop' ? '循环回到句首' : reason === 'seek' ? '跳转后重新确认' : '时间轴回跳，重新确认',
    })
  }

  function startTake(target: LyricLine, position: number, reason: GuideReason = 'start') {
    if (active) stopCue(position, 'reset')
    plan = buildLinePlan(song, target)
    line = target
    mode = 'take'
    pass = 1
    sequence = 0
    events.length = 0
    audible.length = 0
    done = new Set()
    skipped = new Set()
    active = null
    pickupUsed = false
    confirmed = false
    voiced = null
    lastVoicedAt = null
    lastAckAt = -Infinity
    lastAmbiguousAt = -Infinity
    lastSkippedAt = -Infinity
    lastPos = position
    emit('reset', {
      at: position, reason,
      detail: reason === 'loop'
        ? '循环回到句首'
        : reason === 'seek'
          ? '跳到新的位置，从下一个完整提示接入'
          : position > target.start + 0.02 ? '从句子中间开始，从下一个完整提示接入' : '从弱起开始',
    })
  }

  function markSkips(at: number, boundary: number) {
    if (!plan || !line) return
    if (boundary - lastSkippedAt < 0.05) return
    lastSkippedAt = boundary
    // At the line boundary every remaining preset has been passed; a manual
    // stop only reports the presets the playhead already went by.
    const reached = at >= line.end - EPS ? line.end : at
    for (const group of plan.candidates) {
      if (!group.accent || done.has(group.noteIndex) || skipped.has(group.noteIndex)) continue
      if (group.start >= reached - EPS) continue
      skipped.add(group.noteIndex)
      emit('skip', {
        at: boundary,
        reason: group.complete ? 'end' : group.incomplete ?? 'short',
        candidateId: group.id,
        noteIndex: group.noteIndex,
        midi: group.midi,
        start: group.start,
        end: Math.min(group.end, line.end),
        variant: group.variant,
        detail: !group.complete
          ? group.incomplete === 'leap'
            ? '突然拔高的一截，不作接入点'
            : group.incomplete === 'truncated'
              ? '下一句开始前只剩半个音'
              : '剩余时间不足一个提示'
          : '本句已结束',
      })
    }
  }

  function finish(at: number) {
    if (!line) return
    if (active) stopCue(Math.min(at, line.end), 'end')
    markSkips(at, at)
    if (!audible.length) {
      emit('skip', { at: line.end, reason: 'end', detail: '整句没有可完整播出的提示' })
    }
    mode = 'ended'
    lastPos = at
  }

  function advance(position: number) {
    if (mode !== 'take' || !line || !plan) return
    if (!Number.isFinite(position)) return

    if (position < lastPos - 0.06) {
      reset(position, position < line.start - 0.06 ? 'seek' : 'jump')
      return
    }
    if (position - lastPos > JUMP_FORWARD) {
      reset(position, 'jump')
      scan(position)
      return
    }
    lastPos = position

    if (active && position >= active.candidate.end - EPS) {
      const cue = active
      stopCue(cue.candidate.end, 'completed')
      if (cue.joined) {
        emit('yield', {
          at: cue.event.end ?? position, reason: 'yield',
          candidateId: cue.event.candidateId, noteIndex: cue.event.noteIndex, midi: cue.event.midi,
          start: cue.event.start, variant: cue.event.variant,
          detail: '弱起已提示，后面的旋律留给你',
        })
        lastAckAt = position
      } else if (cue.pickup) {
        emit('miss', { at: cue.event.end ?? position, reason: 'missed', detail: '弱起没有接上' })
      } else {
        emit('miss', { at: cue.event.end ?? position, reason: 'missed', detail: '这一处提示没有接上' })
      }
    }

    if (confirmed && lastVoicedAt !== null && position - lastVoicedAt > MISS_GAP) {
      confirmed = false
      voiced = null
      lastVoicedAt = null
      emit('miss', { at: position, reason: 'missed', detail: '声音中断，等待下一处可完整接入的提示' })
    }

    if (position >= line.end - EPS) {
      finish(line.end)
      return
    }
    if (active || confirmed) return
    scan(position)
  }

  function endTake(position?: number) {
    if (mode !== 'take') return
    // A run still in progress at the very end is judged by the same evidence
    // rules; a short blip there is reported rather than silently dropped.
    if (voiced && voiced.last - voiced.start < CONFIRM_SPAN) {
      noteAmbiguous(voiced.last, '录音结束时未确认的短促声音')
    }
    finish(position ?? (Number.isFinite(lastPos) ? lastPos : line?.end ?? 0))
  }

  function snapshot(): GuideSnapshot {
    const phase: GuidePhase = mode === 'ended' ? 'ended'
      : mode === 'idle' ? 'idle'
      : active ? (active.pickup ? 'pickup' : 'prompting')
      : confirmed ? 'yielding' : 'listening'
    const next = plan ? nextPreset(plan, lastPos, done) : null
    return {
      phase,
      confirmed,
      activeCandidateId: active?.candidate.id ?? null,
      nextCandidate: next,
      lastEvent: events.at(-1) ?? null,
      pass,
    }
  }

  return {
    startTake,
    endTake,
    advance,
    observe,
    reset,
    snapshot,
    plan: () => plan,
    events: () => events as readonly GuideEvent[],
    audible: () => audible as readonly GuideEvent[],
  }
}

export type GuideEngine = ReturnType<typeof createGuideEngine>
