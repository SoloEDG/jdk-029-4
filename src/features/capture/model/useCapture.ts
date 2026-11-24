import { onBeforeUnmount, ref } from 'vue'
import type { PcmFrame, TimeRange } from '../../../shared/document'
import { openInput } from '../lib/input'
import { toWave } from '../lib/wave'

interface CaptureTarget {
  songId: string
  lineId: string
  range: TimeRange
}

interface CapturedAudio extends TimeRange {
  audio: Blob
  songId: string
  lineId: string
}

interface CaptureEvents {
  onFrame: (time: number, samples: Float32Array, rate: number) => void
  onComplete: (result: CapturedAudio) => Promise<void>
  /** Fired when a take actually starts, after the microphone is live. */
  onStart?: (target: CaptureTarget, position: number) => void
  position: () => number
}

type Input = Awaited<ReturnType<typeof openInput>>
type ActiveCapture = CaptureTarget & { inputStart: number; songStart: number; frames: PcmFrame[] }

export function useCapture(events: CaptureEvents) {
  const status = ref<'idle' | 'requesting' | 'recording' | 'saving'>('idle')
  const issue = ref('')
  const level = ref(0)
  let input: Input | null = null
  let active: ActiveCapture | null = null
  let request = 0

  function receive(frame: PcmFrame) {
    if (!active || !input) return
    const time = active.songStart + frame.inputTime - active.inputStart
    const end = time + frame.samples.length / input.sampleRate
    if (end <= active.songStart || time >= active.range.end) return
    active.frames.push(frame)
    if (status.value !== 'recording') return
    const rms = Math.sqrt(frame.samples.reduce((sum, value) => sum + value * value, 0) / frame.samples.length)
    level.value = Math.min(1, rms * 4)
    const midpoint = (time + end) / 2
    if (midpoint >= active.songStart && midpoint < active.range.end) {
      events.onFrame(midpoint, frame.samples, input.sampleRate)
    }
  }

  function live(target: CaptureTarget, stream: Input) {
    active = { ...target, inputStart: stream.clock(), songStart: events.position(), frames: [] }
    status.value = 'recording'
    events.onStart?.(target, active.songStart)
  }

  async function start(target: CaptureTarget, preparePlayback: () => Promise<boolean>) {
    if (status.value !== 'idle') return
    const token = ++request
    status.value = 'requesting'
    issue.value = ''
    try {
      const stream = await openInput(receive, () => {
        issue.value = '麦克风已断开。'
        if (status.value === 'requesting') cancelRequest()
        else void stop(events.position())
      })
      if (token !== request) { stream.close(); return }
      input = stream
      if (!await preparePlayback() || token !== request) {
        if (input === stream) cancelRequest()
        return
      }
      live(target, stream)
    } catch (error) {
      if (token !== request) return
      cancelRequest()
      issue.value = error instanceof DOMException && error.name === 'NotAllowedError'
        ? '麦克风权限未开启。' : '无法开启麦克风，请检查设备和访问权限。'
    }
  }

  /**
   * Begin a new take on the microphone that is already open (after a seek or
   * a loop wrap). The accompaniment keeps running; only the take boundary
   * moves, so the guide sees a fresh pass with fresh evidence.
   */
  async function resume(target: CaptureTarget): Promise<boolean> {
    if (status.value !== 'idle' || !input) return false
    live(target, input)
    return true
  }

  /** Release a microphone kept open between takes. */
  function release() {
    // Only the owner of an idle capture may close it: a release racing a
    // save (or the microphone handshake) would orphan the take.
    if (status.value !== 'idle') return
    input?.close()
    input = null
  }

  function cancelRequest() {
    if (status.value !== 'requesting') return
    request++
    input?.close()
    input = null
    status.value = 'idle'
  }

  async function stop(position: number, options: { keepInput?: boolean } = {}) {
    if (status.value !== 'recording' || !active || !input) return false
    status.value = 'saving'
    const recording = active
    const stream = input
    const keepInput = options.keepInput ?? false
    const end = Math.max(recording.songStart, Math.min(position, recording.range.end))
    const duration = end - recording.songStart
    try {
      await stream.flush()
      if (duration < 0.2 || !recording.frames.length) {
        issue.value = '录音少于 0.2 秒，未保存。'
        return false
      }
      const audio = toWave(recording.frames, recording.inputStart, duration, stream.sampleRate)
      await events.onComplete({ audio, start: recording.songStart, end, songId: recording.songId, lineId: recording.lineId })
      return true
    } catch {
      issue.value = '录音未能保存。'
      return false
    } finally {
      if (!keepInput) {
        stream.close()
        if (input === stream) input = null
      }
      active = null
      level.value = 0
      status.value = 'idle'
    }
  }

  onBeforeUnmount(() => {
    request++
    if (status.value !== 'saving') input?.close()
    input = null
  })
  return { status, issue, level, start, resume, stop, cancelRequest, release }
}
