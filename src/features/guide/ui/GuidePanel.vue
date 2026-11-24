<script setup lang="ts">
import { CornerDownRight, Music2, Sparkles, TriangleAlert, Waypoints } from '@lucide/vue'
import type { GuideEvent, LyricLine } from '../../../shared/document'
import { clockLabel } from '../../../shared/time'
import type { EntryCandidate, NoteGroup } from '../lib/plan'
import type { GuideSnapshot } from '../lib/engine'
import { guideEventLabel } from '../lib/replay'

const props = defineProps<{
  line: LyricLine | null
  snapshot: GuideSnapshot
  pairs: NoteGroup[]
  events: GuideEvent[]
  auditioning: boolean
  enabled: boolean
  volume: number
}>()
const emit = defineEmits<{ audition: []; toggle: []; volume: [number] }>()

const phaseCopy: Record<GuideSnapshot['phase'], string> = {
  idle: '待命',
  listening: '听你开口',
  pickup: '弱起提示',
  prompting: '提示中',
  yielding: '让位',
  ended: '本句结束',
}

function candidateTitle(candidate: EntryCandidate) {
  if (candidate.variant === 'settle') {
    return candidate.complete ? '元音接入：过了开头辅音' : '元音接入不可用'
  }
  return candidate.complete ? '弱起接入：从音头开始' : '弱起接入不可用'
}

function candidateReason(candidate: EntryCandidate) {
  if (candidate.complete) return ''
  if (candidate.incomplete === 'leap') return '突然拔高'
  if (candidate.incomplete === 'truncated') return '只剩半个音'
  if (candidate.incomplete === 'short') return '太短'
  return '不可用'
}

function eventTime(event: GuideEvent) {
  return clockLabel(event.at, true)
}
</script>

<template>
  <section class="guide-panel" aria-labelledby="guide-title">
    <div class="guide-heading">
      <h2 id="guide-title" class="panel-heading"><Waypoints :size="17" /> 会跟唱的导唱</h2>
      <div class="guide-actions">
        <button class="ghost-button" :class="{ on: enabled }" type="button" :aria-pressed="enabled" @click="emit('toggle')">
          {{ enabled ? '导唱开' : '导唱关' }}
        </button>
        <label class="guide-volume"><Music2 :size="14" />
          <input aria-label="导唱音量" type="range" min="0" max="1" step="0.01" :value="volume"
            :style="{ '--fill': `${volume * 100}%` }" @input="emit('volume', Number(($event.target as HTMLInputElement).value))" />
        </label>
        <button class="ghost-button audition" type="button" :disabled="!line || auditioning" @click="emit('audition')">
          <Sparkles :size="14" /> {{ auditioning ? '试听中' : '试听这一句' }}
        </button>
      </div>
    </div>

    <div class="guide-body">
      <div class="guide-status">
        <p class="guide-phase" :data-phase="snapshot.phase">{{ auditioning ? '试听' : phaseCopy[snapshot.phase] }}</p>
        <p class="guide-line-name">{{ line?.text ?? '未选择练习句' }}</p>
        <p v-if="snapshot.confirmed" class="guide-confirm"><CornerDownRight :size="13" /> 已确认接唱，后面留给你</p>
        <p v-else-if="snapshot.nextCandidate && !auditioning" class="guide-next">
          下一处可完整接入 · <span class="mono">{{ clockLabel(snapshot.nextCandidate.start, true) }}</span>
        </p>
        <p v-else class="guide-next">导唱按能确认的证据出声</p>
        <p v-if="auditioning" class="guide-next">正在用导唱声预演整句，不计入本次录音</p>
      </div>

      <div v-if="pairs.length" class="guide-pairs">
        <p class="guide-pairs-title">重音附近的接入候选</p>
        <ol v-for="group in pairs" :key="group.noteIndex" class="guide-pair">
          <li v-for="candidate in group.candidates" :key="candidate.id">
            <span class="pair-dot" :class="candidate.variant"></span>
            <span class="pair-copy">
              <strong>{{ candidate.variant === 'attack' ? '弱起' : '元音' }}</strong>
              <small class="mono">{{ clockLabel(candidate.start, true) }}</small>
            </span>
            <span v-if="!candidate.complete" class="pair-flag"><TriangleAlert :size="11" /> {{ candidateReason(candidate) }}</span>
            <span v-else class="pair-ok">{{ candidateTitle(candidate) }}</span>
          </li>
        </ol>
      </div>
      <p v-else class="guide-next">这一句没有可用的接入点；伴奏与歌词照常走。</p>
    </div>

    <ol v-if="events.length" class="guide-log" aria-label="导唱进程">
      <li v-for="event in events.slice(-6)" :key="event.id" :data-kind="event.kind">
        <span class="mono log-time">{{ eventTime(event) }}</span>
        <span class="log-kind" :class="event.kind">{{ guideEventLabel(event) }}</span>
        <span class="log-detail">{{ event.detail ?? (event.variant === 'settle' ? '元音接入' : event.variant === 'attack' ? '弱起接入' : '') }}</span>
      </li>
    </ol>
  </section>
</template>
