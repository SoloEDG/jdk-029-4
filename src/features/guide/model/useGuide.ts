import { computed, onBeforeUnmount, shallowRef, watch } from 'vue'
import type { GuideEvent, GuideReason, LyricLine, Song } from '../../../shared/document'
import { createGuideEngine, type GuideSnapshot, type GuideSink } from '../lib/engine'
import { accentGroups, buildLinePlan, type EntryCandidate, type LinePlan } from '../lib/plan'
import { createGuideVoice, type VoiceHandle } from '../lib/voice'

export type GuideResetReason = 'seek' | 'loop' | 'jump'

const idle: GuideSnapshot = {
  phase: 'idle', confirmed: false, activeCandidateId: null, nextCandidate: null, lastEvent: null, pass: 0,
}

/**
 * Binds the guide engine to a synthesized voice. The engine owns every
 * decision; this layer only starts/stops tones and mirrors the snapshot for
 * the UI. Nothing is scheduled ahead for a take, so a yield or a jump
 * silences the guide within the same animation frame. The audition preview is
 * the one exception: it is a listening aid, never part of a take.
 */
export function useGuide(song: () => Song, position: () => number) {
  const snapshot = shallowRef<GuideSnapshot>(idle)
  const events = shallowRef<GuideEvent[]>([])
  const enabled = shallowRef(true)
  const volume = shallowRef(0.8)
  const auditioning = shallowRef(false)
  const linePlan = shallowRef<LinePlan | null>(null)
  const voice = createGuideVoice()
  let engine: ReturnType<typeof createGuideEngine> | null = null
  let current: VoiceHandle | null = null
  let auditionTones: VoiceHandle[] = []
  let auditionTimer = 0

  function mute() {
    current?.stop()
    current = null
  }

  function stopAudition() {
    window.clearTimeout(auditionTimer)
    auditioning.value = false
    for (const tone of auditionTones) tone.stop()
    auditionTones = []
  }

  const sink: GuideSink = {
    start(event, _at, candidate: EntryCandidate) {
      mute()
      if (!enabled.value || event.midi == null) return
      const from = Math.max(candidate.start, position())
      const duration = candidate.end - from
      if (duration < 0.05) return
      voice.resume()
      voice.setVolume(volume.value)
      current = voice.play(candidate.midi, duration)
    },
    stop() {
      mute()
    },
  }

  function sync() {
    if (engine) snapshot.value = engine.snapshot()
  }

  function pull() {
    if (engine) events.value = [...engine.events()]
  }

  function build() {
    mute()
    engine = createGuideEngine(song(), sink)
    events.value = []
  }

  /** Precompute the entry plan for a phrase without starting a take. */
  function prepare(line: LyricLine | null) {
    if (engine) return
    linePlan.value = line ? buildLinePlan(song(), line) : null
  }

  function startTake(line: LyricLine, start: number, reason: GuideReason = 'start') {
    stopAudition()
    linePlan.value = buildLinePlan(song(), line)
    build()
    engine?.startTake(line, start, reason)
    pull()
    sync()
  }

  function advance(now: number) {
    if (!engine) return
    engine.advance(now)
    pull()
    sync()
  }

  function observe(time: number, midi: number | null) {
    if (!engine) return
    engine.observe(time, midi)
    pull()
    sync()
  }

  function reset(now: number, reason: GuideResetReason) {
    if (!engine) return
    engine.reset(now, reason)
    mute()
    pull()
    sync()
  }

  function endTake(at?: number): GuideEvent[] {
    if (!engine) return events.value
    engine.endTake(at)
    mute()
    pull()
    sync()
    return events.value
  }

  function clear() {
    mute()
    stopAudition()
    engine = null
    events.value = []
    linePlan.value = null
    snapshot.value = idle
  }

  function setEnabled(next: boolean) {
    enabled.value = next
    if (!next) mute()
  }

  function setVolume(next: number) {
    volume.value = Math.min(1, Math.max(0, next))
    voice.setVolume(volume.value)
  }

  /**
   * Preview the selected phrase before singing it. When the accompaniment is
   * already rolling, the preview locks onto the song clock; otherwise it
   * starts immediately from the line's first note.
   */
  function audition(line: LyricLine, playing: boolean, now: number) {
    if (engine) return
    stopAudition()
    voice.resume()
    voice.setVolume(volume.value)
    const plan = buildLinePlan(song(), line)
    linePlan.value = plan
    auditioning.value = true
    const notes = plan.notes
    if (!notes.length) { auditioning.value = false; return }
    const followsSong = playing && now < line.end
    const anchor = followsSong ? Math.max(now, line.start) : notes[0].start
    const delay = followsSong ? Math.max(0, line.start - now) : 0
    for (const note of notes) {
      const start = note.start
      const end = Math.min(note.end, line.end)
      if (end - start < 0.08) continue
      const offset = delay + Math.max(0, start - anchor)
      const duration = end - Math.max(start, anchor)
      if (duration < 0.08) continue
      auditionTones.push(voice.schedule(note.midi, offset, duration))
    }
    const total = delay + (Math.min(notes.at(-1)!.end, line.end) - anchor)
    auditionTimer = window.setTimeout(stopAudition, Math.max(500, total * 1000 + 450))
  }

  const active = computed(() => events.value.at(-1) ?? null)
  const audibleCount = computed(() =>
    events.value.filter(event => event.kind === 'pickup' || event.kind === 'cue').length)

  /** Silence everything immediately (tab hidden, transport paused). */
  function hush() {
    mute()
    stopAudition()
  }
  const pairs = computed(() => linePlan.value ? accentGroups(linePlan.value) : [])

  // Keep the candidate legend in step with the phrase selected in the rail.
  watch(song, () => { if (!engine) linePlan.value = null })

  onBeforeUnmount(() => {
    mute()
    stopAudition()
    voice.close()
  })

  return {
    voice, snapshot, events, enabled, volume, active, audibleCount, auditioning, linePlan, pairs,
    startTake, advance, observe, reset, endTake, clear, setEnabled, setVolume, audition, stopAudition, prepare, hush,
  }
}
