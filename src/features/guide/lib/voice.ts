export interface VoiceHandle {
  stop: () => void
}

interface Tone {
  stop: () => void
}

function frequency(midi: number) {
  return 440 * 2 ** ((midi - 69) / 12)
}

/**
 * Small Web Audio voice used for the guide. It is deliberately separate from
 * the accompaniment so a prompt can be cut the instant the singer is heard,
 * and so review can replay the exact prompts that sounded.
 */
export function createGuideVoice() {
  let context: AudioContext | null = null
  let master: GainNode | null = null
  let level = 0.8
  const tones = new Set<Tone>()

  function ensure() {
    if (context) {
      if (context.state === 'suspended') void context.resume()
      return context
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    context = new Ctor()
    master = new GainNode(context, { gain: level * 0.2 })
    const filter = new BiquadFilterNode(context, { type: 'lowpass', frequency: 2600 })
    master.connect(filter).connect(context.destination)
    return context
  }

  function tone(midi: number, when: number, duration: number): Tone | null {
    const ctx = ensure()
    if (!ctx || !master) return null
    const start = Math.max(ctx.currentTime, when)
    const length = Math.max(0.08, duration)
    const env = new GainNode(ctx, { gain: 0 })
    const fundamental = new OscillatorNode(ctx, { type: 'sine', frequency: frequency(midi) })
    const overtone = new OscillatorNode(ctx, { type: 'sine', frequency: frequency(midi) * 2 })
    const colour = ctx.createGain()
    colour.gain.value = 0.16
    const vibrato = new OscillatorNode(ctx, { type: 'sine', frequency: 5.2 })
    const depth = ctx.createGain()
    depth.gain.value = frequency(midi) * 0.005
    vibrato.connect(depth).connect(fundamental.frequency)
    fundamental.connect(env)
    overtone.connect(colour).connect(env)
    env.connect(master)

    env.gain.setValueAtTime(0, start)
    env.gain.linearRampToValueAtTime(1, start + 0.02)
    env.gain.setValueAtTime(1, start + Math.max(0.03, length - 0.06))
    env.gain.linearRampToValueAtTime(0, start + length)
    fundamental.start(start)
    overtone.start(start)
    vibrato.start(start)
    const end = start + length + 0.02
    fundamental.stop(end)
    overtone.stop(end)
    vibrato.stop(end)

    let stopped = false
    const handle: Tone = {
      stop() {
        if (stopped) return
        stopped = true
        const now = ctx.currentTime
        if (env.gain.cancelAndHoldAtTime) env.gain.cancelAndHoldAtTime(now)
        else env.gain.cancelScheduledValues(now)
        env.gain.setTargetAtTime(0, now, 0.015)
        try {
          fundamental.stop(now + 0.06)
          overtone.stop(now + 0.06)
          vibrato.stop(now + 0.06)
        } catch { /* already stopped */ }
        window.setTimeout(() => {
          try { env.disconnect() } catch { /* already disconnected */ }
          tones.delete(handle)
        }, 100)
      },
    }
    tones.add(handle)
    return handle
  }

  function play(midi: number, duration: number): VoiceHandle {
    const ctx = ensure()
    if (!ctx) return { stop() {} }
    const handle = tone(midi, ctx.currentTime + 0.015, duration)
    return { stop: () => handle?.stop() }
  }

  /** Schedule a tone at a known offset (used by review playback). */
  function schedule(midi: number, offset: number, duration: number): VoiceHandle {
    const ctx = ensure()
    if (!ctx) return { stop() {} }
    const handle = tone(midi, ctx.currentTime + Math.max(0, offset), duration)
    return { stop: () => handle?.stop() }
  }

  function setVolume(next: number) {
    level = next
    if (master && context) master.gain.setTargetAtTime(next * 0.2, context.currentTime, 0.03)
  }

  function stopAll() {
    for (const handle of [...tones]) handle.stop()
  }

  function close() {
    stopAll()
    if (context) void context.close()
    context = null
    master = null
  }

  return { play, schedule, setVolume, stopAll, close, resume: ensure }
}

export type GuideVoice = ReturnType<typeof createGuideVoice>
