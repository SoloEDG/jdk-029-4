<script setup lang="ts">
import { Mic, Sparkles, Square } from '@lucide/vue'
import type { LyricLine } from '../../../shared/document'
import GuideMini from '../../guide/ui/GuideMini.vue'
import type { GuideSnapshot } from '../../guide/lib/engine'
import type { NoteGroup } from '../../guide/lib/plan'

defineProps<{
  status: 'idle' | 'requesting' | 'recording' | 'saving'
  issue: string
  level: number
  selected: LyricLine | null
  guide: GuideSnapshot
  auditioning: boolean
  pairs: NoteGroup[]
}>()
const emit = defineEmits<{ toggle: [] }>()
</script>

<template>
  <section class="record-strip" aria-label="麦克风录音">
    <div class="record-label">
      <span class="status-dot" :class="{ hot: status === 'recording' }"></span>
      <div><strong>麦克风</strong>
        <small>{{ status === 'recording' ? '录音中' : status === 'requesting' ? '等待授权' : status === 'saving' ? '保存中' : '待命' }}</small>
      </div>
    </div>
    <div class="level-meter" :aria-label="`麦克风输入 ${Math.round(level * 100)}%`" role="meter"
      aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.round(level * 100)">
      <i v-for="step in 16" :key="step" :class="{ lit: level * 16 >= step }"></i>
    </div>
    <GuideMini :snapshot="guide" :pairs="pairs" :auditioning="auditioning" />
    <button class="record-button" :class="{ recording: status === 'recording' }"
      :disabled="status === 'saving' || !selected || auditioning" @click="emit('toggle')">
      <Square v-if="status === 'recording'" :size="15" fill="currentColor" />
      <Sparkles v-else-if="auditioning" :size="15" /><Mic v-else :size="16" />
      {{ status === 'recording' ? '停止录音' : status === 'requesting' ? '取消录音' : auditioning ? '试听中' : '录制这一句' }}
    </button>
    <p v-if="issue" role="alert" class="inline-error">{{ issue }}</p>
  </section>
</template>
