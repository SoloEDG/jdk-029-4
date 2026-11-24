import { describe, expect, it } from 'vitest'
import type { GuideEvent } from '../../src/shared/document'
import { guideSchedule, guideSummary, guideEventLabel } from '../../src/features/guide/lib/replay'

const event = (fields: Partial<GuideEvent> & { id: string }): GuideEvent => ({
  kind: 'cue', at: 0, pass: 1, lineId: 'line', ...fields,
})

describe('review replay', () => {
  it('clips prompts to the take window', () => {
    const events: GuideEvent[] = [
      event({ id: 'a', kind: 'pickup', midi: 60, start: 2.6, end: 3.4 }),
      event({ id: 'b', kind: 'cue', midi: 67, start: 5.4, end: 6.76 }),
      event({ id: 'c', kind: 'cue', midi: 64, start: 9.0, end: 9.4 }),
    ]
    const schedule = guideSchedule(events, 3.0, 6.0)
    expect(schedule.map(entry => entry.eventId)).toEqual(['a', 'b'])
    expect(schedule[0].offset).toBe(0)
    expect(schedule[0].duration).toBeCloseTo(0.4, 2)
    expect(schedule[1].offset).toBeCloseTo(2.4, 2)
    expect(schedule[1].duration).toBeCloseTo(0.6, 2)
  })

  it('drops prompts with no audible length', () => {
    const events: GuideEvent[] = [
      event({ id: 'a', kind: 'cue', midi: 60, start: 3.0, end: 3.02 }),
      event({ id: 'b', kind: 'cue', midi: 60, start: 3.0, end: 3.2 }),
      event({ id: 'c', kind: 'yield', at: 3.2 }),
      event({ id: 'd', kind: 'cue', midi: null, start: 4, end: 5 }),
    ]
    expect(guideSchedule(events, 0, 10).map(entry => entry.eventId)).toEqual(['b'])
  })

  it('summarizes only what actually happened', () => {
    const events: GuideEvent[] = [
      event({ id: 'a', kind: 'pickup', midi: 60, start: 2.6, end: 3.4 }),
      event({ id: 'b', kind: 'yield', at: 3.4 }),
      event({ id: 'c', kind: 'miss', at: 4, reason: 'ambiguous' }),
      event({ id: 'd', kind: 'skip', at: 5, reason: 'truncated' }),
      event({ id: 'e', kind: 'cue', midi: 64, start: 5.4, end: 6.0 }),
    ]
    expect(guideSummary(events)).toMatchObject({ prompts: 2, pickups: 1, yields: 1, skips: 1, ambiguities: 1 })
    expect(guideSummary(undefined)).toMatchObject({ prompts: 0, yields: 0 })
  })

  it('labels every decision kind for the log', () => {
    const labels = ['pickup', 'cue', 'yield', 'miss', 'skip', 'reset'].map(kind =>
      guideEventLabel(event({ id: kind, kind: kind as GuideEvent['kind'] })))
    expect(labels).toEqual(['弱起提示', '接入提示', '让位', '漏唱', '跳过', '重新确认'])
    // An unconfirmable blip is labelled as such rather than as a miss.
    expect(guideEventLabel(event({ id: 'amb', kind: 'miss', reason: 'ambiguous' }))).toBe('判不清')
  })
})
