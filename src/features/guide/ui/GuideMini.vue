<script setup lang="ts">
import { Ear, Sparkles } from '@lucide/vue'
import type { GuideSnapshot } from '../lib/engine'
import type { NoteGroup } from '../lib/plan'

defineProps<{ snapshot: GuideSnapshot; pairs: NoteGroup[]; auditioning: boolean }>()

const phases: Record<GuideSnapshot['phase'], string> = {
  idle: '待命', listening: '听你开口', pickup: '弱起提示',
  prompting: '提示中', yielding: '让位', ended: '本句结束',
}
</script>

<template>
  <div class="guide-mini" aria-live="polite">
    <span v-if="auditioning" class="mini-state audition"><Sparkles :size="13" /> 试听中</span>
    <span v-else class="mini-state" :data-phase="snapshot.phase"><Ear :size="13" /> {{ phases[snapshot.phase] }}</span>
    <span v-if="snapshot.confirmed" class="mini-confirm">已接唱 · 留给你</span>
    <span v-else-if="snapshot.nextCandidate" class="mini-next mono">下一处 {{ snapshot.nextCandidate.start.toFixed(2) }}s</span>
    <span v-for="group in pairs.slice(0, 2)" :key="group.noteIndex" class="mini-pair" :title="`重音 ${group.midi} 的两个接入候选`">
      <i class="mini-dot attack"></i><i class="mini-dot settle" :class="{ muted: group.settle && !group.settle.complete }"></i>
    </span>
  </div>
</template>
