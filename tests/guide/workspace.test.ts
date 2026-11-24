// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

/**
 * End-to-end wiring test for the workspace: microphone frames in, saved take
 * with guide events out. Web Audio, the worklet and IndexedDB are stubbed at
 * their module boundaries; the guide engine, plan and clock are the real ones.
 */

const frames: { push: (time: number, samples: Float32Array) => void } = { push: () => {} }
const takes: unknown[] = []

vi.mock('../../src/features/capture/lib/input', () => ({
  openInput: vi.fn(async (onFrame: (frame: { inputTime: number; samples: Float32Array }) => void) => {
    let now = 0
    frames.push = (time, samples) => { now = time; onFrame({ inputTime: time, samples }) }
    return { clock: () => now, sampleRate: 48000, flush: async () => {}, close: () => {} }
  }),
}))

vi.mock('../../src/features/capture/lib/wave', () => ({
  toWave: vi.fn(() => new Blob([new Uint8Array(4)], { type: 'audio/wav' })),
}))

vi.mock('../../src/features/review/lib/archive', () => ({
  readTakes: vi.fn(async () => []),
  writeTake: vi.fn(async (take: unknown) => { takes.push(take) }),
}))

// A silent-but-stable detector; individual tests override the return value.
let pitchValue: number | null = null
vi.mock('../../src/features/pitch/lib/detect', () => ({
  samplePitch: vi.fn(() => pitchValue),
  noteName: () => 'C4',
}))

vi.mock('../../src/features/guide/lib/voice', () => ({
  createGuideVoice: () => ({
    play: vi.fn(() => ({ stop: vi.fn() })),
    schedule: vi.fn(() => ({ stop: vi.fn() })),
    setVolume: vi.fn(), stopAll: vi.fn(), close: vi.fn(), resume: vi.fn(),
  }),
}))

const songs = (await import('../../src/features/playback/model/demo-songs.json')).default

function stubAudio() {
  class FakeAudio extends EventTarget {
    static instances: FakeAudio[] = []
    currentTime = 0
    duration = 0
    paused = true
    ended = false
    seeking = false
    volume = 1
    preload = ''
    src = ''
    constructor(src = '') { super(); this.src = src; FakeAudio.instances.push(this) }
    load() {}
    pause() { this.paused = true }
    async play() { this.paused = false; this.ended = false; return undefined }
    removeAttribute() {}
  }
  vi.stubGlobal('Audio', FakeAudio)
  return FakeAudio
}

function stubAudioContext() {
  class FakeContext {
    state = 'running'
    currentTime = 0
    sampleRate = 48000
    destination = {}
    audioWorklet = { addModule: async () => {} }
    resume() { return Promise.resolve() }
    close() { return Promise.resolve() }
    createMediaStreamSource() { return { connect: (node: unknown) => node, disconnect() {} } }
  }
  vi.stubGlobal('AudioContext', FakeContext)
  vi.stubGlobal('AudioWorkletNode', class {
    port = { onmessage: null, postMessage: () => {}, close() {} }
    connect(node: unknown) { return node }
    disconnect() {}
  })
  vi.stubGlobal('GainNode', class { constructor() {} connect(node: unknown) { return node } disconnect() {} })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [{ addEventListener() {}, stop() {} }] }) } })
}

async function setup() {
  stubAudio()
  stubAudioContext()
  takes.length = 0
  pitchValue = null
  const { useWorkspace } = await import('../../src/app/useWorkspace')
  return useWorkspace()
}

describe('workspace guide wiring', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('stores the prompts that actually sounded on a saved take', async () => {
    const workspace = await setup()
    const line = workspace.transport.song.value.lines[0]
    workspace.selectLine(line.id)
    workspace.toggleRecording()
    await vi.waitFor(() => expect(workspace.capture.status.value).toBe('recording'))

    // The guide opens on the line start; no voice is detected. Input time and
    // song time advance together, as they do when the microphone is live.
    let clock = 0
    for (let t = line.start; t <= line.end + 0.05; t += 0.04) {
      workspace.transport.position.value = t
      frames.push(clock, new Float32Array(2048))
      clock += 0.04
      await nextTick()
    }
    await vi.waitFor(() => expect(takes.length).toBe(1))
    const take = takes[0] as { guide: { kind: string }[]; start: number; end: number }
    expect(take.guide.map(event => event.kind)).toContain('pickup')
    expect(take.guide.filter(event => event.kind === 'pickup' || event.kind === 'cue')).toHaveLength(2)
    expect(take.end).toBeGreaterThan(take.start)
  })

  it('lets the guide yield to a real, sustained voice', async () => {
    const workspace = await setup()
    const line = workspace.transport.song.value.lines[0]
    workspace.selectLine(line.id)
    workspace.toggleRecording()
    await vi.waitFor(() => expect(workspace.capture.status.value).toBe('recording'))
    pitchValue = 62

    let clock = 0
    for (let t = line.start; t <= line.end + 0.05; t += 0.04) {
      workspace.transport.position.value = t
      frames.push(clock, new Float32Array(2048))
      clock += 0.04
      await nextTick()
    }
    await vi.waitFor(() => expect(takes.length).toBe(1))
    const take = takes[0] as { guide: { kind: string }[] }
    expect(take.guide.some(event => event.kind === 'yield')).toBe(true)
    // The pickup sounds once, and the rest is handed over.
    expect(take.guide.filter(event => event.kind === 'pickup')).toHaveLength(1)
    expect(take.guide.filter(event => event.kind === 'cue')).toHaveLength(0)
  })

  it('keeps the mic open and starts a fresh pass on a real loop wrap', async () => {
    const workspace = await setup()
    const line = workspace.transport.song.value.lines[0]
    workspace.selectLine(line.id)
    workspace.transport.loop.value = line
    workspace.toggleRecording()
    await vi.waitFor(() => expect(workspace.capture.status.value).toBe('recording'))

    let clock = 0
    for (let t = line.start; t < line.end - 0.3; t += 0.04) {
      workspace.transport.position.value = t
      frames.push(clock, new Float32Array(2048))
      clock += 0.04
      await nextTick()
    }
    expect(takes.length).toBe(0)

    // The transport wraps when the audio clock passes the loop end.
    const audio = (globalThis.Audio as unknown as { instances: FakeAudio[] }).instances[0]
    audio.paused = false
    audio.currentTime = line.end + 0.02
    audio.dispatchEvent(new Event('timeupdate'))
    await vi.waitFor(() => expect(takes.length).toBe(1))
    // The take that wrapped is saved with what it actually played...
    const first = takes[0] as { guide: { kind: string }[] }
    expect(first.guide.some(event => event.kind === 'pickup')).toBe(true)
    // ...and the next pass starts on the open microphone at the line head.
    await vi.waitFor(() => expect(workspace.capture.status.value).toBe('recording'))
    expect(workspace.transport.position.value).toBe(line.start)
    // The fresh take starts its own pass at the head of the phrase.
    expect(workspace.guide.snapshot.value.pass).toBe(1)
    expect(workspace.guide.snapshot.value.phase).not.toBe('ended')
    expect(first.guide.filter(event => event.kind === 'pickup')).toHaveLength(1)
    // The re-opened take carries the loop reason...
    expect(workspace.guide.events.value[0]).toMatchObject({ kind: 'reset', reason: 'loop' })
    // ...and, on the next frames, re-offers the head preset in full.
    for (let t = line.start; t < line.start + 0.1; t += 0.04) {
      workspace.transport.position.value = t
      frames.push(clock, new Float32Array(2048))
      clock += 0.04
      await nextTick()
    }
    const pickup = workspace.guide.events.value.find(event => event.kind === 'pickup')
    expect(pickup).toBeTruthy()
    expect(pickup!.start).toBeCloseTo(line.start, 4)
  })
})
