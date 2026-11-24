import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { LyricLine, Song } from '../../src/shared/document'
import { createGuideEngine } from '../../src/features/guide/lib/engine'
import { guideSchedule } from '../../src/features/guide/lib/replay'

const songs = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../src/features/playback/model/demo-songs.json', import.meta.url)), 'utf8'),
) as Song[]
const tide = songs[0]
const line = (id: string) => tide.lines.find(entry => entry.id === id) as LyricLine

describe('take lifecycle', () => {
  it('keeps the events of the finished take when a loop starts a new pass', () => {
    const target = line('tide-1')
    const engine = createGuideEngine(tide)
    engine.startTake(target, target.start)
    for (let t = 2.66; t < 7.0; t += 0.04) engine.advance(Number(t.toFixed(3)))
    const frozen = guideSchedule(engine.events(), target.start, 7.0)
    engine.startTake(target, 2.7, 'loop')
    // A copied snapshot is not mutated by the next pass.
    expect(frozen).toHaveLength(2)
    expect(guideSchedule(engine.events(), 2.7, 7.0)).toEqual([])
    for (let t = 2.7; t < 7.0; t += 0.04) engine.advance(Number(t.toFixed(3)))
    const second = engine.audible()
    expect(second).toHaveLength(2)
    expect(second.map(event => [event.start, event.end])).toEqual([
      [2.66667, 3.40667], [5.4, 6.76667],
    ])
    expect(engine.events().some(event => event.kind === 'reset' && event.reason === 'loop')).toBe(true)
  })

  it('does not invent prompts after a manual stop before the line ends', () => {
    const target = line('tide-1')
    const engine = createGuideEngine(tide)
    engine.startTake(target, target.start)
    for (let t = 2.66; t < 3.4; t += 0.04) engine.advance(Number(t.toFixed(3)))
    engine.reset(3.4, 'seek')
    expect(engine.audible()).toHaveLength(1)
    expect(engine.events().filter(event => event.kind === 'skip')).toEqual([])
  })

  it('reports the final prompt that was already over when the take ended', () => {
    const target = line('tide-1')
    const engine = createGuideEngine(tide)
    engine.startTake(target, target.start)
    for (let t = 2.66; t < 7.0; t += 0.04) engine.advance(Number(t.toFixed(3)))
    expect(engine.audible()).toHaveLength(2)
    const skips = engine.events().filter(event => event.kind === 'skip')
    expect(skips.some(event => event.reason === 'truncated')).toBe(false)
  })
})
