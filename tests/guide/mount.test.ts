// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

vi.mock('@lucide/vue', () => {
  const icon = { template: '<svg />' }
  const names = ['AudioLines', 'Disc3', 'Waves', 'MicVocal', 'ListMusic', 'Play', 'Pause', 'Repeat2',
    'SkipBack', 'SkipForward', 'Volume2', 'VolumeX', 'Mic', 'Square', 'Activity', 'Headphones',
    'GitCompareArrows', 'CornerDownRight', 'Music2', 'Sparkles', 'TriangleAlert', 'Waypoints', 'Ear']
  return Object.fromEntries(names.map(name => [name, icon]))
})

vi.mock('../../src/features/capture/lib/input', () => ({
  openInput: vi.fn(async () => ({ clock: () => 0, sampleRate: 48000, flush: async () => {}, close: () => {} })),
}))
vi.mock('../../src/features/capture/lib/wave', () => ({ toWave: vi.fn(() => new Blob([])) }))
vi.mock('../../src/features/review/lib/archive', () => ({ readTakes: async () => [], writeTake: async () => {} }))
vi.mock('../../src/features/pitch/lib/detect', () => ({ samplePitch: () => null, noteName: () => 'C4' }))
vi.mock('../../src/features/guide/lib/voice', () => ({
  createGuideVoice: () => ({
    play: vi.fn(() => ({ stop: vi.fn() })), schedule: vi.fn(() => ({ stop: vi.fn() })),
    setVolume: vi.fn(), stopAll: vi.fn(), close: vi.fn(), resume: vi.fn(),
  }),
}))

function stubBrowser() {
  class FakeAudio extends EventTarget {
    static instances: FakeAudio[] = []
    currentTime = 0; paused = true; ended = false; seeking = false; volume = 1; src = ''; preload = ''
    constructor(src = '') { super(); this.src = src; FakeAudio.instances.push(this) }
    load() {} pause() { this.paused = true }
    async play() { this.paused = false; return undefined }
    removeAttribute() {}
  }
  vi.stubGlobal('Audio', FakeAudio)
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
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext']
}

describe('workspace shell', () => {
  it('mounts with the guide panel and compact guide status', async () => {
    stubBrowser()
    const Workspace = (await import('../../src/app/Workspace.vue')).default
    const wrapper = mount(Workspace)
    await nextTick()
    expect(wrapper.find('.guide-panel').exists()).toBe(true)
    expect(wrapper.find('.guide-mini').exists()).toBe(true)
    expect(wrapper.find('.guide-pairs, .guide-next').exists()).toBe(true)
    expect(wrapper.text()).toContain('会跟唱的导唱')
    expect(wrapper.text()).toContain('试听这一句')
    // The picker explains the two candidate kinds and their clock positions.
    expect(wrapper.findAll('.guide-pair li').length).toBeGreaterThanOrEqual(2)
    // And the compact status sits next to the record controls.
    expect(wrapper.find('.record-strip .guide-mini').exists()).toBe(true)
    wrapper.unmount()
  })
})
