// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { GuideEvent, Song } from '../../src/shared/document'
import demoSongs from '../../src/features/playback/model/demo-songs.json'
import GuidePanel from '../../src/features/guide/ui/GuidePanel.vue'
import GuideMini from '../../src/features/guide/ui/GuideMini.vue'
import { accentGroups, buildLinePlan } from '../../src/features/guide/lib/plan'
import { createGuideEngine, type GuideSnapshot } from '../../src/features/guide/lib/engine'
import { guideSchedule } from '../../src/features/guide/lib/replay'

const songs = demoSongs as unknown as Song[]
const tide = songs[0]

vi.mock('@lucide/vue', () => {
  const icon = { template: '<svg data-icon="1" />' }
  const names = ['CornerDownRight', 'Music2', 'Sparkles', 'TriangleAlert', 'Waypoints', 'Ear', 'Activity', 'Mic', 'Square', 'Play', 'Download', 'RotateCcw']
  return Object.fromEntries(names.map(name => [name, icon]))
})

const idle: GuideSnapshot = {
  phase: 'idle', confirmed: false, activeCandidateId: null, nextCandidate: null, lastEvent: null, pass: 0,
}

const stubs = { CornerDownRight: true, Music2: true, Sparkles: true, TriangleAlert: true, Waypoints: true, Ear: true }

function mountPanel(targetId: string, events: GuideEvent[] = [], snapshot = idle) {
  const line = tide.lines.find(entry => entry.id === targetId)!
  const plan = buildLinePlan(tide, line)
  return mount(GuidePanel, {
    props: {
      line, snapshot, pairs: accentGroups(plan), events, auditioning: false, enabled: true, volume: 0.8,
    },
    global: { stubs },
  })
}

describe('guide panel', () => {
  it('shows each accent with two distinguishable entry candidates', () => {
    const wrapper = mountPanel('tide-1')
    const rows = wrapper.findAll('.guide-pair li')
    expect(rows.length).toBeGreaterThanOrEqual(4)
    const texts = rows.map(row => row.text())
    const firstAccent = texts.slice(0, 2)
    expect(firstAccent[0]).toContain('弱起')
    expect(firstAccent[1]).toContain('元音')
    expect(firstAccent[0]).toMatch(/\d\d:\d\d\.\d/)
    expect(firstAccent[1]).toMatch(/\d\d:\d\d\.\d/)
    // Different clock labels: the two presets do not coincide.
    expect(firstAccent[0]).not.toBe(firstAccent[1])
  })

  it('marks the leap entry as unavailable instead of offering a slice of the jump', () => {
    const wrapper = mountPanel('tide-7')
    const flagged = wrapper.findAll('.pair-flag').map(node => node.text())
    expect(flagged.some(text => text.includes('拔高'))).toBe(true)
  })

  it('renders the decision log honestly, including a skipped truncated prompt', () => {
    const events: GuideEvent[] = [
      { id: 'e1', kind: 'pickup', at: 2.66, pass: 1, lineId: 'tide-1', candidateId: 'tide-1:0:attack', midi: 60, start: 2.66, end: 3.4 },
      { id: 'e2', kind: 'yield', at: 3.4, pass: 1, lineId: 'tide-1', detail: '弱起已提示，后面的旋律留给你' },
      { id: 'e3', kind: 'skip', at: 6.7, pass: 1, lineId: 'tide-1', reason: 'truncated', detail: '下一句开始前只剩半个音' },
    ]
    const wrapper = mountPanel('tide-1', events)
    const log = wrapper.findAll('.guide-log li').map(node => node.text())
    expect(log.some(text => text.includes('弱起提示'))).toBe(true)
    expect(log.some(text => text.includes('让位'))).toBe(true)
    expect(log.some(text => text.includes('半个音'))).toBe(true)
  })

  it('reflects a confirmed hand-over and the next entry point', () => {
    const line = tide.lines[0]
    const plan = buildLinePlan(tide, line)
    const engine = createGuideEngine(tide)
    engine.startTake(line, line.start)
    for (let t = 2.66; t <= 3.1; t += 0.04) {
      engine.observe(Number(t.toFixed(3)), t > 2.7 ? 60 : null)
      engine.advance(Number(t.toFixed(3)))
    }
    const wrapper = mountPanel('tide-1', engine.events() as GuideEvent[], engine.snapshot())
    expect(wrapper.text()).toContain('已确认接唱')
    expect(accentGroups(plan).length).toBeGreaterThan(0)
  })

  it('rebuilds a replay track from the saved prompts only', () => {
    const events: GuideEvent[] = [
      { id: 'e1', kind: 'pickup', at: 2.66, pass: 1, lineId: 'tide-1', midi: 60, start: 2.66, end: 3.4 },
      { id: 'e2', kind: 'yield', at: 3.4, pass: 1, lineId: 'tide-1' },
      { id: 'e3', kind: 'skip', at: 5.39, pass: 1, lineId: 'tide-1', reason: 'late', detail: '已经过去' },
      { id: 'e4', kind: 'cue', at: 5.4, pass: 1, lineId: 'tide-1', midi: 67, start: 5.4, end: 6.76667 },
    ]
    const schedule = guideSchedule(events, 2.66667, 7.0)
    expect(schedule.map(entry => entry.eventId)).toEqual(['e1', 'e4'])
    const takeStart = 2.66667
    expect(schedule[1].offset).toBeCloseTo(5.4 - takeStart, 3)
  })

  it('shows the compact state next to the record controls', () => {
    const line = tide.lines[0]
    const plan = buildLinePlan(tide, line)
    const engine = createGuideEngine(tide)
    engine.startTake(line, line.start)
    engine.advance(line.start)
    const wrapper = mount(GuideMini, {
      props: { snapshot: engine.snapshot(), pairs: accentGroups(plan), auditioning: false },
      global: { stubs: { Ear: true, Sparkles: true } },
    })
    expect(wrapper.text()).toContain('弱起提示')
    expect(wrapper.findAll('.mini-pair').length).toBeGreaterThan(0)
  })
})
