import type { GuideEvent } from '../../../shared/document'

export interface GuideTone {
  eventId: string
  kind: 'pickup' | 'cue'
  midi: number
  /** Seconds from the start of the take. */
  offset: number
  duration: number
}

/**
 * Turn the prompts recorded on a take into a playback schedule. The events
 * carry the moment they were cut (yield, miss or line end), so review hears
 * exactly the prompts that sounded — including truncated ones.
 */
export function guideSchedule(events: readonly GuideEvent[] | undefined, takeStart: number, takeEnd: number): GuideTone[] {
  if (!events?.length) return []
  const tones: GuideTone[] = []
  for (const event of events) {
    if (event.kind !== 'pickup' && event.kind !== 'cue') continue
    if (event.midi == null || event.start == null || event.end == null) continue
    const from = Math.max(takeStart, event.start)
    const to = Math.min(takeEnd, event.end)
    if (to - from < 0.04) continue
    tones.push({
      eventId: event.id,
      kind: event.kind,
      midi: event.midi,
      offset: from - takeStart,
      duration: to - from,
    })
  }
  return tones.sort((a, b) => a.offset - b.offset)
}

export function guideSummary(events: readonly GuideEvent[] | undefined) {
  const audible = (events ?? []).filter(event => event.kind === 'pickup' || event.kind === 'cue')
  return {
    prompts: audible.length,
    pickups: audible.filter(event => event.kind === 'pickup').length,
    yields: (events ?? []).filter(event => event.kind === 'yield').length,
    skips: (events ?? []).filter(event => event.kind === 'skip').length,
    ambiguities: (events ?? []).filter(event => event.kind === 'miss' && event.reason === 'ambiguous').length,
  }
}

export function guideEventLabel(event: GuideEvent) {
  switch (event.kind) {
    case 'pickup': return '弱起提示'
    case 'cue': return '接入提示'
    case 'yield': return '让位'
    case 'miss': return event.reason === 'ambiguous' ? '判不清' : '漏唱'
    case 'skip': return '跳过'
    case 'reset': return '重新确认'
    default: return event.kind
  }
}
