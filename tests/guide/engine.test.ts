import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { GuideEvent, LyricLine, Song } from '../../src/shared/document'
import { buildLinePlan, nextPreset } from '../../src/features/guide/lib/plan'
import { createGuideEngine } from '../../src/features/guide/lib/engine'
import { guideSchedule } from '../../src/features/guide/lib/replay'

const songs = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../src/features/playback/model/demo-songs.json', import.meta.url)), 'utf8'),
) as Song[]

const tide = songs[0]
const dawn = songs[1]
const line = (song: Song, id: string) => song.lines.find(entry => entry.id === id) as LyricLine

interface Step { t: number; midi?: number | null; note?: string }

function harness(song: Song, target: LyricLine, start = target.start) {
  const started: GuideEvent[] = []
  const stopped: GuideEvent[] = []
  const engine = createGuideEngine(song, {
    start: event => started.push({ ...event }),
    stop: event => stopped.push({ ...event }),
  })
  engine.startTake(target, start)
  return {
    engine,
    started,
    stopped,
    run(steps: Step[]) {
      for (const step of steps) {
        engine.observe(step.t, step.midi ?? null)
        engine.advance(step.t)
      }
      return this
    },
    finish(at?: number) {
      engine.endTake(at)
      return this
    },
    kinds: () => engine.events().map(event => event.kind),
    audibleIds: () => engine.audible().map(event => event.candidateId),
  }
}

/** A steady voiced run from `from` to `to` sampled every 40 ms. */
function sing(from: number, to: number, midi: number): Step[] {
  const steps: Step[] = []
  for (let t = from; t <= to + 1e-6; t += 0.04) steps.push({ t: Number(t.toFixed(3)), midi })
  return steps
}

/** Timeline marks where nothing is detected, sampled every 40 ms. */
function silence(from: number, to: number): Step[] {
  const steps: Step[] = []
  for (let t = from; t <= to + 1e-6; t += 0.04) steps.push({ t: Number(t.toFixed(3)), midi: null })
  return steps
}

describe('entry candidates', () => {
  it('gives every accent two distinguishable presets and withholds the settle on a leap', () => {
    const plan = buildLinePlan(tide, line(tide, 'tide-7'))
    const accent = plan.candidates.filter(candidate => candidate.noteIndex === 27)
    expect(accent.map(candidate => candidate.variant)).toEqual(['attack', 'settle'])
    expect(accent[0].midi).toBe(accent[1].midi)
    // Distinguishable: they do not share a start, and only the attack begins on the consonant.
    expect(accent[1].start - accent[0].start).toBeGreaterThan(0.1)
    expect(accent[0].guard).toBe(0)
    expect(accent[0].complete).toBe(true)
    // The leap settles onto a raised slice, so that preset is not offered.
    expect(accent[0].leap).toBe(true)
    expect(accent[1].complete).toBe(false)
    expect(accent[1].incomplete).toBe('leap')
  })

  it('rejects a final note that cannot be played in full before the line ends', () => {
    // Build a synthetic line whose last note runs 0.2 s past the line end.
    const base = line(dawn, 'dawn-8')
    const clipped: LyricLine = { ...base, id: 'clip', end: 41.9 }
    const plan = buildLinePlan(dawn, clipped)
    const last = plan.candidates.at(-1)!
    expect(last.complete).toBe(false)
    expect(last.incomplete).toBe('truncated')
    // Nothing full-length is left before the boundary.
    expect(nextPreset(plan, 40.7, new Set())).toBeNull()
  })
})

describe('guide behavior', () => {
  it('prompts the same phrase, keeps the pickup, then yields once the singer joins', () => {
    const target = line(tide, 'tide-1')
    const h = harness(tide, target)
    h.run([
      ...silence(2.62, 2.94),
      ...sing(3.0, 6.9, 62), // singer starts late, on the second note
      ...silence(6.94, 7.0),
    ]).finish()

    const events = h.engine.events()
    expect(h.audibleIds()).toEqual(['tide-1:0:attack'])
    expect(events.find(event => event.kind === 'pickup')?.midi).toBe(60)
    const yieldEvent = events.find(event => event.kind === 'yield')
    expect(yieldEvent).toBeTruthy()
    // The pickup is allowed to finish its note; the yield happens after it.
    expect(yieldEvent!.at).toBeGreaterThanOrEqual(3.4)
    // Nothing else is prompted after the singer is confirmed.
    expect(h.started).toHaveLength(1)
    expect(h.stopped[0].end).toBeCloseTo(3.407, 2)
    const schedule = guideSchedule(events, target.start, target.end)
    expect(schedule).toHaveLength(1)
    expect(schedule[0]).toMatchObject({ kind: 'pickup', midi: 60 })
    expect(schedule[0].duration).toBeCloseTo(0.74, 2)
  })

  it('re-enters at the next accent after a missed pickup, without clipping the preset', () => {
    const target = line(tide, 'tide-1')
    const h = harness(tide, target)
    h.run([...silence(2.62, 7.0)]).finish()
    const events = h.engine.events()
    const audible = h.engine.audible()

    expect(audible.map(event => event.candidateId)).toEqual(['tide-1:0:attack', 'tide-1:3:attack'])
    expect(audible.map(event => event.midi)).toEqual([60, 67])
    // The second prompt starts exactly on the accent, full length, not clipped.
    expect(audible[1].start).toBeCloseTo(5.4, 3)
    expect(audible[1].end).toBeCloseTo(6.76667, 2)
    const miss = events.find(event => event.kind === 'miss' && event.at >= 3.4)
    expect(miss?.reason).toBe('missed')
  })

  it('treats a noise blip as unconfirmable and falls back to the next full preset', () => {
    const target = line(tide, 'tide-1')
    const h = harness(tide, target)
    h.run([
      ...silence(2.62, 2.86),
      { t: 2.88, midi: 84 }, // 2-frame spike
      ...silence(2.92, 3.5),
      ...silence(3.5, 5.3),
      ...silence(5.3, 7.0),
    ]).finish()
    expect(h.audibleIds()).toEqual(['tide-1:0:attack', 'tide-1:3:attack'])
    const ambiguous = h.engine.events().filter(event => event.reason === 'ambiguous')
    expect(ambiguous.length).toBeGreaterThan(0)
  })

  it('keeps the weak-start hint when the singer starts on time, then yields the rest', () => {
    const target = line(tide, 'tide-1')
    const h = harness(tide, target)
    h.run([...sing(2.66, 6.9, 60)]).finish()
    // The pickup is the one hint that stays even when the singer is on time.
    expect(h.audibleIds()).toEqual(['tide-1:0:attack'])
    const events = h.engine.events()
    expect(events.find(event => event.kind === 'pickup')).toBeTruthy()
    expect(events.find(event => event.kind === 'yield')).toBeTruthy()
    // No other prompt is played over the singer.
    expect(h.started).toHaveLength(1)
  })

  it('recovers on a late rejoin: keeps timing, then offers one clean re-entry', () => {
    const target = line(tide, 'tide-1')
    const h = harness(tide, target)
    h.run([
      ...silence(2.62, 2.94),
      ...sing(3.0, 3.95, 64), // joins late, sings one note, drops out
      ...silence(4.0, 7.0),
    ]).finish()
    const audible = h.engine.audible()
    expect(audible.map(event => event.candidateId)).toEqual(['tide-1:0:attack', 'tide-1:3:attack'])
    // The re-entry starts cleanly on the accent, after the dropout gap.
    expect(audible[1].start).toBeGreaterThanOrEqual(5.4)
    expect(audible[1].start).toBeLessThanOrEqual(5.5)
    expect(h.engine.events().filter(event => event.kind === 'miss' && event.reason === 'missed').length)
      .toBeGreaterThanOrEqual(1)
  })

  it('never starts the half note at the end of a line and reports the end honestly', () => {
    const target = line(dawn, 'dawn-8')
    const h = harness(dawn, target)
    h.run([...silence(target.start - 0.02, target.end)]).finish()
    const audible = h.engine.audible()
    // The last preset is the long final note (40.785–42.25), full length.
    expect(audible.at(-1)?.candidateId).toBe('dawn-8:31:attack')
    expect(audible.at(-1)?.start).toBeCloseTo(40.78571, 2)
    expect(audible.at(-1)?.end).toBeCloseTo(42.25, 2)
    const skips = h.engine.events().filter(event => event.kind === 'skip')
    expect(skips.some(event => event.detail?.includes('半个音'))).toBe(false)
  })

  it('re-confirms after a backward jump instead of reusing confirmed evidence', () => {
    const target = line(tide, 'tide-2')
    const h = harness(tide, target)
    h.run([
      ...silence(7.33, 7.45),
      ...sing(7.45, 7.92, 67), // confirms and yields
    ])
    expect(h.engine.audible()[0].candidateId).toBe('tide-2:4:attack')

    // Back to the line head with no fresh evidence: the pickup is offered again,
    // and the old confirmation cannot silence the new pass.
    h.engine.reset(target.start, 'jump')
    h.run([...silence(target.start, 12.0)]).finish()
    const after = h.engine.events().filter(event => event.pass >= 2)
    expect(after.some(event => event.kind === 'reset' && event.reason === 'jump')).toBe(true)
    const audibleAfter = h.engine.audible().filter(event => event.pass >= 2)
    expect(audibleAfter[0].candidateId).toBe('tide-2:4:attack')
    expect(audibleAfter[0].start).toBeCloseTo(7.33333, 3)
    expect(h.engine.events().find(event => event.pass === 2 && event.kind === 'pickup')).toBeTruthy()
  })

  it('at a mid-line jump, enters at the vowel-safe preset of the current accent', () => {
    const target = line(tide, 'tide-2')
    const h = harness(tide, target)
    h.run([...silence(7.33, 7.45), ...sing(7.45, 7.9, 67)])
    // Jump to the vowel part of the first accent: the attack is already under
    // way, so the settle point is used — the same accent, past the consonant,
    // and still long enough to be played in full.
    h.engine.reset(7.55, 'jump')
    h.run([...silence(7.55, 12.0)]).finish()
    const audibleAfter = h.engine.audible().filter(event => event.pass >= 2)
    expect(audibleAfter[0].candidateId).toBe('tide-2:4:settle')
    expect(audibleAfter[0].start).toBeCloseTo(7.51833, 3)
    expect(audibleAfter[0].end).toBeCloseTo(8.07333, 3)
  })

  it('shares one plan across passes so looped playback replays the same presets', () => {
    const target = line(tide, 'tide-3')
    const h = harness(tide, target)
    h.run([...silence(12.0, 16.3)]).finish()
    const first = h.engine.audible().map(event => [event.candidateId, event.start, event.end])
    h.engine.reset(target.start, 'loop')
    h.run([...silence(12.0, 16.3)]).finish()

    const second = h.engine.audible().filter(event => event.pass === 2).map(event => [event.candidateId, event.start, event.end])
    expect(second).toEqual(first)
    const resets = h.engine.events().filter(event => event.kind === 'reset' && event.reason === 'loop')
    expect(resets).toHaveLength(1)
  })
})

describe('half-played evidence', () => {
  it('reports a short blip that is cut off by the end of the take', () => {
    const target = line(tide, 'tide-1')
    const h = harness(tide, target)
    h.run([...silence(2.62, 5.38), { t: 5.4, midi: 80 }])
    h.finish(5.42)
    const ambiguous = h.engine.events().filter(event => event.reason === 'ambiguous')
    expect(ambiguous.length).toBeGreaterThan(0)
    expect(h.engine.snapshot().confirmed).toBe(false)
  })
})
