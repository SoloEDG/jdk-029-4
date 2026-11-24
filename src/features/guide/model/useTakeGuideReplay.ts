import { computed, shallowRef, watch } from 'vue'
import type { Take } from '../../../shared/document'
import type { GuideVoice } from '../lib/voice'
import { guideSchedule } from '../lib/replay'

/**
 * Plays a stored take together with the prompts that actually sounded on it.
 * The guide track is rebuilt from the take's own events, so review never
 * invents a prompt the singer did not hear — and a prompt that was cut short
 * by a yield is replayed cut short too.
 */
export function useTakeGuideReplay(voice: GuideVoice) {
  const playingId = shallowRef<string | null>(null)
  const offset = shallowRef(0)
  const audibleKind = shallowRef<'pickup' | 'cue' | null>(null)
  const audibleCount = shallowRef(0)
  let handles: { stop: () => void }[] = []
  let frame = 0
  let startedAt = 0
  let take: Take | null = null

  function clear() {
    cancelAnimationFrame(frame)
    for (const handle of handles) handle.stop()
    handles = []
    playingId.value = null
    audibleKind.value = null
    audibleCount.value = 0
    offset.value = 0
    take = null
  }

  function tick(clock: () => number) {
    if (!take) return
    const elapsed = clock() - startedAt
    offset.value = Math.max(0, Math.min(take.end - take.start, elapsed))
    const schedule = guideSchedule(take.guide, take.start, take.end)
    const sounding = schedule.find(entry => offset.value >= entry.offset && offset.value < entry.offset + entry.duration)
    audibleKind.value = sounding?.kind ?? null
    audibleCount.value = schedule.filter(entry => offset.value >= entry.offset).length
    if (elapsed < take.end - take.start + 0.08) frame = requestAnimationFrame(() => tick(clock))
    else playingId.value = null
  }

  function start(target: Take, clock: () => number) {
    clear()
    take = target
    playingId.value = target.id
    startedAt = clock()
    const schedule = guideSchedule(target.guide, target.start, target.end)
    voice.resume()
    handles = schedule.map(entry => voice.schedule(entry.midi, entry.offset, entry.duration))
    tick(clock)
  }

  watch(playingId, value => { if (!value && take) clear() })

  const prompts = computed(() => (take ? guideSchedule(take.guide, take.start, take.end) : []))

  return { playingId, offset, audibleKind, audibleCount, prompts, start, stop: clear }
}

export type TakeGuideReplay = ReturnType<typeof useTakeGuideReplay>
