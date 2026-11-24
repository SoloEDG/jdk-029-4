import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { GuideEvent, LyricLine, Song } from '../../src/shared/document'
import { buildLinePlan, nextPreset } from '../../src/features/guide/lib/plan'
import { createGuideEngine } from '../../src/features/guide/lib/engine'
import { guideSchedule, guideSummary } from '../../src/features/guide/lib/replay'

const songs = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../src/features/playback/model/demo-songs.json', import.meta.url)), 'utf8'),
) as Song[]
const tide = songs[0]
const dawn = songs[1]
const line = (song: Song, id: string) => song.lines.find(entry => entry.id === id) as LyricLine

interface Mark { t: number; midi: number | null }
const silence = (from: number, to: number): Mark[] => {
  const marks: Mark[] = []
  for (let t = from; t <= to + 1e-6; t += 0.04) marks.push({ t: Number(t.toFixed(3)), midi: null })
  return marks
}
const voice = (from: number, to: number, midi: number): Mark[] => {
  const marks: Mark[] = []
  for (let t = from; t <= to + 1e-6; t += 0.04) marks.push({ t: Number(t.toFixed(3)), midi })
  return marks
}

function harness(song: Song, target: LyricLine) {
  const started: GuideEvent[] = []
  const stopped: GuideEvent[] = []
  const engine = createGuideEngine(song, {
    start: event => started.push({ ...event }),
    stop: event => stopped.push({ ...event }),
  })
  engine.startTake(target, target.start)
  return {
    engine, started, stopped,
    run(marks: Mark[]) {
      for (const mark of marks) { engine.observe(mark.t, mark.midi); engine.advance(mark.t) }
      return this
    },
    finish(at?: number) { engine.endTake(at); return this },
    audible: () => engine.audible(),
  }
}

/** Song with a line whose final note is cut in half by the line boundary. */
function clippedSong(): { song: Song; line: LyricLine } {
  const base = dawn
  // Beat is 0.714 s. The opening note is the first accent, the second is long
  // enough to count as an accent, and the third starts on the strong beat but
  // has only ~0.09 s before the line ends.
  const target: LyricLine = { id: 'dawn-half', text: '末尾半个音', start: 40.0, end: 42.95 }
  const song: Song = {
    ...base,
    id: 'clip',
    lines: [target],
    notes: [
      { start: 40.0, end: 40.8, midi: 57 },
      { start: 41.44, end: 42.54, midi: 59 },
      { start: 42.86, end: 43.5, midi: 60 },
    ],
  }
  return { song, line: target }
}

describe('missed then rushed recovery', () => {
  it('misses the pickup, then offers a clean accent after the singer rushes in', () => {
    const target = line(tide, 'tide-1')
    const h = harness(tide, target)
    h.run([
      ...silence(2.62, 3.0),
      ...voice(3.0, 3.2, 60),      // brief rushed entry
      ...silence(3.24, 5.42),
      ...voice(5.45, 6.9, 67),      // back in on the accent
    ]).finish()

    const audible = h.audible()
    expect(audible.map(event => event.kind)).toEqual(['pickup', 'cue'])
    expect(audible[1].start).toBeCloseTo(5.4, 3)
    // The re-entry cue is cut the moment the singer is confirmed, not clipped
    // by the preset itself: it starts at the accent and is silenced on evidence.
    const yieldEvent = h.engine.events().find(event => event.kind === 'yield' && event.candidateId === 'tide-1:3:attack')
    expect(yieldEvent).toBeTruthy()
    expect(audible[1].end).toBeLessThan(6.76667)
  })
})

describe('final half note', () => {
  it('declines a preset that has only half a note left and logs why', () => {
    const { song, line: target } = clippedSong()
    const plan = buildLinePlan(song, target)
    const last = plan.candidates.at(-1)!
    expect(last.complete).toBe(false)
    expect(last.incomplete).toBe('truncated')
    expect(nextPreset(plan, 42.86, new Set())).toBeNull()
  })

  it('stops before the half note instead of stitching it in', () => {
    const { song, line: target } = clippedSong()
    const h = harness(song, target)
    h.run(silence(target.start - 0.02, target.end)).finish()
    const audible = h.audible()
    expect(audible.at(-1)?.candidateId).toBe('dawn-half:1:attack')
    expect(audible.at(-1)?.end).toBeCloseTo(42.54, 3)
    const skip = h.engine.events().find(event => event.kind === 'skip' && event.candidateId?.includes(':2:'))
    expect(skip?.reason).toBe('truncated')
    expect(skip?.detail).toContain('半个音')
  })

  it('never lets a prompt run past the lyric line', () => {
    const { song, line: target } = clippedSong()
    const h = harness(song, target)
    h.run(silence(target.start - 0.02, target.end)).finish()
    for (const event of h.audible()) {
      expect(event.end!).toBeLessThanOrEqual(target.end + 1e-6)
      expect(event.start!).toBeGreaterThanOrEqual(target.start - 1e-6)
    }
  })
})

describe('jumping back', () => {
  it('re-confirms from fresh evidence after a jump and replays the head preset', () => {
    const target = line(tide, 'tide-1')
    const h = harness(tide, target)
    h.run([...silence(2.66, 2.94), ...voice(3.0, 4.2, 64)])
    h.engine.reset(2.8, 'jump')
    h.run(silence(2.8, 7.0)).finish()
    const second = h.audible().filter(event => event.pass === 2)
    expect(second[0].candidateId).toBe('tide-1:0:settle')
    expect(second[0].start).toBeCloseTo(2.85167, 3)
    expect(h.engine.events().some(event => event.pass === 2 && event.kind === 'reset')).toBe(true)
    // The same preset from the same evidence yields the same slot every time.
    expect(nextPreset(h.engine.plan()!, 2.8, new Set())?.id).toBe('tide-1:0:settle')
  })

  it('does not treat a fast backward scrub as a normal frame', () => {
    const target = line(tide, 'tide-3')
    const h = harness(tide, target)
    h.run([...silence(12.0, 15.3)])
    h.engine.advance(12.1) // one frame back mid-prompt
    expect(h.engine.events().some(event => event.kind === 'reset' && event.reason === 'jump')).toBe(true)
  })

  it('treats a large forward jump as a re-confirmation point', () => {
    const target = line(tide, 'tide-1')
    const h = harness(tide, target)
    h.engine.advance(2.66)
    h.engine.advance(4.8) // jumped ahead, no frames in between
    const reset = h.engine.events().find(event => event.kind === 'reset' && event.reason === 'jump')
    expect(reset).toBeTruthy()
    h.run(silence(4.84, 7.0)).finish()
    const tail = h.audible().at(-1)
    expect(tail?.start).toBeCloseTo(5.4, 3)
  })
})

describe('dragging into the middle of a phrase', () => {
  it('starts from the next full preset and never clips the one under the playhead', () => {
    const target = line(tide, 'tide-1')
    const h = harness(tide, target)
    h.engine.reset(4.6, 'seek')
    h.run(silence(4.6, 7.0)).finish()
    expect(h.audible().map(event => event.candidateId)).toEqual(['tide-1:3:attack'])
    expect(h.audible()[0].start).toBeCloseTo(5.4, 3)
    expect(h.audible()[0].end).toBeCloseTo(6.76667, 2)
  })
})

describe('short noise spikes', () => {
  it('does not treat a one-frame spike as a singer', () => {
    const target = line(tide, 'tide-1')
    const h = harness(tide, target)
    h.run([
      ...silence(2.62, 2.9),
      { t: 2.92, midi: 84 },
      ...silence(2.96, 7.0),
    ]).finish()
    expect(h.audible().map(event => event.candidateId)).toEqual(['tide-1:0:attack', 'tide-1:3:attack'])
    expect(h.engine.events().some(event => event.reason === 'ambiguous')).toBe(true)
    expect(h.engine.snapshot().confirmed).toBe(false)
  })

  it('does not confirm a wobbly, unsteady run', () => {
    const target = line(tide, 'tide-1')
    const h = harness(tide, target)
    const wobble: Mark[] = []
    for (let index = 0; index < 14; index++) {
      wobble.push({ t: 3.2 + index * 0.04, midi: index % 2 ? 61 : 68 })
    }
    h.run([...silence(2.62, 3.2), ...wobble, ...silence(3.8, 7.0)]).finish()
    expect(h.engine.snapshot().confirmed).toBe(false)
    expect(h.engine.events().some(event => event.reason === 'ambiguous')).toBe(true)
    // It still falls back to the next preset that can be played in full.
    expect(h.audible().at(-1)?.candidateId).toBe('tide-1:3:attack')
  })

  it('accepts a steady, sustained run as evidence', () => {
    const target = line(tide, 'tide-1')
    const h = harness(tide, target)
    h.run([...silence(2.62, 3.2), ...voice(3.2, 4.0, 61), ...silence(4.04, 7.0)]).finish()
    expect(h.engine.events().some(event => event.kind === 'yield')).toBe(true)
    // After the confirmed drop-out, one clean re-entry is offered.
    expect(h.audible().map(event => event.candidateId)).toEqual(['tide-1:0:attack', 'tide-1:3:attack'])
  })
})

describe('loop', () => {
  it('replays the same prompts on the next pass and does not carry confirmations over', () => {
    const target = line(tide, 'tide-3')
    const h = harness(tide, target)
    h.run(silence(12.0, 16.3)).finish(16.3)
    const first = h.audible().map(event => [event.candidateId, event.start, event.end])
    h.engine.reset(12.0, 'loop')
    h.run([
      ...voice(12.0, 12.6, 60), // this time the singer joins on the head
      ...silence(12.64, 16.3),
    ]).finish(16.3)
    const second = h.audible().filter(event => event.pass === 2)
    expect(second.map(event => event.candidateId)).toEqual(['tide-3:8:attack', 'tide-3:11:attack'])
    expect([second[0].start, second[0].end]).toEqual([first[0][1], first[0][2]])
    expect(h.engine.events().filter(event => event.kind === 'reset' && event.reason === 'loop')).toHaveLength(1)
    expect(h.engine.events().some(event => event.pass === 2 && event.kind === 'yield')).toBe(true)
  })
})

describe('replay', () => {
  it('reproduces exactly the prompts that sounded, including a truncated one', () => {
    const target = line(tide, 'tide-1')
    const h = harness(tide, target)
    h.run([
      ...silence(2.62, 5.4),
      ...voice(5.45, 6.9, 67),
    ]).finish()
    const takeStart = 2.66667
    const takeEnd = 6.9
    const schedule = guideSchedule(h.engine.events(), takeStart, takeEnd)
    expect(schedule).toHaveLength(2)
    expect(schedule[0]).toMatchObject({ kind: 'pickup', midi: 60, offset: 0 })
    expect(schedule[0].duration).toBeCloseTo(0.74, 2)
    expect(schedule[1].kind).toBe('cue')
    expect(schedule[1].offset).toBeCloseTo(5.4 - takeStart, 2)
    // The second prompt was cut by the yield, not by the end of the note.
    expect(schedule[1].duration).toBeLessThan(6.76667 - 5.4)
    const summary = guideSummary(h.engine.events())
    expect(summary.prompts).toBe(2)
    expect(summary.yields).toBeGreaterThan(0)
  })

  it('invents nothing when a take has no guide events', () => {
    expect(guideSchedule(undefined, 0, 5)).toEqual([])
    expect(guideSchedule([], 0, 5)).toEqual([])
  })
})
