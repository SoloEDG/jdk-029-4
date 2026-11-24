// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

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

vi.mock('../../src/features/pitch/lib/detect', () => ({
  samplePitch: vi.fn(() => null), noteName: () => 'C4',
}))

vi.mock('../../src/features/guide/lib/voice', () => ({
  createGuideVoice: () => ({
    play: vi.fn(() => ({ stop: vi.fn() })),
    schedule: vi.fn(() => ({ stop: vi.fn() })),
    setVolume: vi.fn(), stopAll: vi.fn(), close: vi.fn(), resume: vi.fn(),
  }),
}))

function stubAudio() {
  class FakeAudio extends EventTarget {
    static instances: FakeAudio[] = []
    currentTime = 0; paused = true; ended = false; seeking = false; volume = 1; src = ''; preload = ''
    constructor(src = '') { super(); this.src = src; FakeAudio.instances.push(this) }
    load() {} pause() { this.paused = true }
    async play() { this.paused = false; return undefined }
    removeAttribute() {}
  }
  vi.stubGlobal('Audio', FakeAudio)
}

function stubAudioContext() {
  class FakeContext {
    state = 'running'; currentTime = 0; sampleRate = 48000; destination = {}
    audioWorklet = { addModule: async () => {} }
    resume() { return Promise.resolve() } close() { return Promise.resolve() }
    createMediaStreamSource() { return { connect: (node: unknown) => node, disconnect() {} } }
  }
  vi.stubGlobal('AudioContext', FakeContext)
  vi.stubGlobal('AudioWorkletNode', class {
    port = { onmessage: null, postMessage: () => {}, close() {} }
    connect(node: unknown) { return node }
    disconnect() {}
  })
  vi.stubGlobal('GainNode', class { connect(node: unknown) { return node } disconnect() {} })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [{ addEventListener() {}, stop() {} }] }) } })
}

/** Drive both the displayed position and the audio clock the capture reads. */
function positionAt(workspace: { transport: { position: { value: number }; read: () => number } }, time: number) {
  workspace.transport.position.value = time
  const audio = (globalThis.Audio as unknown as { instances: { currentTime: number }[] }).instances[0]
  if (audio) audio.currentTime = time
}

async function recordingWorkspace() {
  stubAudio()
  stubAudioContext()
  takes.length = 0
  const { useWorkspace } = await import('../../src/app/useWorkspace')
  const workspace = useWorkspace()
  const line = workspace.transport.song.value.lines[0]
  workspace.selectLine(line.id)
  workspace.toggleRecording()
  await vi.waitFor(() => expect(workspace.capture.status.value).toBe('recording'))
  return { workspace, line }
}

describe('scrubbing into the middle of a phrase while recording', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('saves the interrupted take and re-opens at the new playhead', async () => {
    const { workspace, line } = await recordingWorkspace()
    let clock = 0
    for (let t = line.start; t < line.start + 0.6; t += 0.04) {
      positionAt(workspace, t)
      frames.push(clock, new Float32Array(2048))
      clock += 0.04
      await nextTick()
    }
    expect(workspace.guide.events.value.some(event => event.kind === 'pickup')).toBe(true)

    // Drag to the middle of the phrase, past the final accent's onset.
    workspace.seek(5.5)
    await vi.waitFor(() => expect(takes.length).toBe(1))
    const first = takes[0] as { guide: { kind: string }[] }
    expect(first.guide.some(event => event.kind === 'pickup')).toBe(true)

    await vi.waitFor(() => expect(workspace.capture.status.value).toBe('recording'))
    expect(workspace.transport.position.value).toBeCloseTo(5.5, 3)
    // The new pass explains itself and waits for fresh evidence.
    expect(workspace.guide.events.value[0]).toMatchObject({ kind: 'reset', reason: 'seek' })
    expect(workspace.guide.snapshot.value.phase).toBe('listening')

    for (let t = 5.5; t < line.end + 0.05; t += 0.04) {
      positionAt(workspace, t)
      frames.push(clock, new Float32Array(2048))
      clock += 0.04
      await nextTick()
    }
    // The attack at 5.4 is under way, so the guide uses the vowel-safe preset
    // of the same accent — a distinct, still-complete entry — not a clipped head.
    const audibles = workspace.guide.events.value.filter(event => event.kind === 'pickup' || event.kind === 'cue')
    expect(audibles).toHaveLength(1)
    expect(audibles[0].candidateId).toBe('tide-1:3:settle')
    expect(audibles[0].start).toBeCloseTo(5.64, 2)
    expect(audibles[0].end).toBeCloseTo(6.76667, 2)
  })

  it('stays silent once no preset can still be played in full', async () => {
    const { workspace, line } = await recordingWorkspace()
    workspace.seek(6.0)
    await vi.waitFor(() => expect(workspace.capture.status.value).toBe('recording'))
    for (let t = 6.0; t < line.end + 0.05; t += 0.04) {
      positionAt(workspace, t)
      frames.push(t, new Float32Array(2048))
      await nextTick()
    }
    const audibles = workspace.guide.events.value.filter(event => event.kind === 'pickup' || event.kind === 'cue')
    expect(audibles).toHaveLength(0)
    expect(workspace.guide.events.value.some(event => event.kind === 'skip')).toBe(true)
  })

  it('does not open a take when the scrub lands outside the phrase', async () => {
    const { workspace } = await recordingWorkspace()
    let clock = 0
    const line = workspace.transport.song.value.lines[0]
    for (let t = line.start; t < line.start + 0.4; t += 0.04) {
      positionAt(workspace, t)
      frames.push(clock, new Float32Array(2048))
      clock += 0.04
      await nextTick()
    }
    workspace.seek(2.0)
    await vi.waitFor(() => expect(takes.length).toBe(1))
    await vi.waitFor(() => expect(workspace.capture.status.value).toBe('idle'))
    // The scrub settles after a short debounce; the playhead then moves.
    await vi.waitFor(() => expect(workspace.transport.position.value).toBe(2.0))
    // Outside the phrase no new take opens, so no new guide pass is claimed.
    expect(workspace.guide.snapshot.value.phase).toBe('idle')
  })
})
