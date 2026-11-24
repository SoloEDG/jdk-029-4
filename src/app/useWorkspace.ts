import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { songs, useTransport } from '../features/playback'
import { useLyrics } from '../features/lyrics'
import { useCapture } from '../features/capture'
import { usePitch } from '../features/pitch'
import { useReview } from '../features/review'
import { useGuide, useTakeGuideReplay } from '../features/guide'
import type { GuideEvent, GuideReason, LyricLine, Song, Take } from '../shared/document'

export function useWorkspace() {
  let pendingGuide: GuideEvent[] | null = null
  let keepMic = false
  let takeReason: GuideReason = 'start'
  /** A take is being closed or reopened on purpose; leave the mic alone. */
  let holdMic = false
  const transport = useTransport(songs[0], {
    beforeSeek: position => {
      void finishCapture(position).then(saved => { if (!holdMic && !saved) capture.release() })
    },
    onPause: position => {
      if (holdMic) return
      void finishCapture(position).then(() => capture.release())
    },
    onLoop: handleLoop,
  })
  const lyrics = useLyrics(transport.song, transport.position)
  const pitch = usePitch()
  const guide = useGuide(() => transport.song.value, transport.read)
  const replay = useTakeGuideReplay(guide.voice)
  const review = useReview(transport.song, lyrics.selected, () => {
    capture.cancelRequest()
    transport.pause()
  }, {
    onListen: take => replay.start(take, () => review.player.currentTime),
    onStop: () => replay.stop(),
  })
  const capture = useCapture({
    onFrame: (time, samples, rate) => {
      const midi = pitch.receive(time, samples, rate)
      if (capture.status.value === 'recording') guide.observe(time, midi)
    },
    onStart: target => {
      pendingGuide = null
      const line = lineById(target.lineId)
      if (line) guide.startTake(line, transport.read(), takeReason)
    },
    position: transport.read,
    onComplete: async result => {
      // The prompts were frozen when the take stopped, before a loop or a
      // seek could start the guide on a fresh pass.
      const guideEvents = pendingGuide ?? guide.events.value
      pendingGuide = null
      await review.save({
        ...result, id: crypto.randomUUID(), createdAt: Date.now(),
        pitch: pitch.slice(result),
        // Detached copies: a later pass must never rewrite saved history.
        guide: guideEvents.map(event => ({ ...event })),
      })
      // The take ended on its own (line boundary or transport pause). Let go
      // of a microphone kept open for a continuation that will not come.
      if (!keepMic && !holdMic) capture.release()
    },
  })
  const graphRange = computed(() => {
    if (review.position.value !== null || !transport.isPlaying.value || capture.status.value === 'recording') {
      return lyrics.selected.value ?? { start: 0, end: transport.song.value.duration }
    }
    return lyrics.active.value ?? lyrics.upcoming.value ?? lyrics.selected.value!
  })
  const graphPosition = computed(() => review.position.value ?? transport.position.value)

  function lineById(id: string): LyricLine | undefined {
    return transport.song.value.lines.find(line => line.id === id)
  }

  /** Stop the running take and freeze the prompts that actually sounded. */
  function finishCapture(position: number): Promise<boolean> {
    if (capture.status.value !== 'recording') return Promise.resolve(false)
    if (!pendingGuide) pendingGuide = [...guide.endTake(position)]
    return capture.stop(position, { keepInput: keepMic })
  }

  function takeTarget(line: LyricLine) {
    return { songId: transport.song.value.id, lineId: line.id, range: line }
  }

  async function handleLoop(boundary: number): Promise<void> {
    // A pause can arrive first (transport sync then wraps); never abandon a
    // take that is already being saved.
    if (capture.status.value === 'saving') return
    holdMic = true
    keepMic = true
    try {
      await finishCapture(boundary)
    } finally {
      keepMic = false
    }
    const line = lyrics.selected.value
    if (!line) { capture.release(); return }
    // The new pass at the head of the phrase is a fresh take with fresh
    // evidence; the take that wrapped was already saved with its own prompts.
    takeReason = 'loop'
    const resumed = await capture.resume(takeTarget(line))
    takeReason = 'start'
    holdMic = false
    if (resumed) pitch.clear()
    else capture.release()
  }

  /** Re-open the take at the new playhead after a scrub during recording. */
  async function restartAt(position: number, reason: 'seek'): Promise<boolean> {
    const line = lyrics.selected.value
    if (!line || position < line.start || position >= line.end) {
      // No take is possible outside the phrase; the accompaniment carries on
      // and the microphone is released.
      capture.release()
      guide.clear()
      guide.prepare(lyrics.selected.value)
      return false
    }
    takeReason = reason
    const resumed = await capture.resume(takeTarget(line))
    takeReason = 'start'
    holdMic = false
    if (resumed) {
      guide.prepare(line)
      pitch.clear()
      return true
    }
    return false
  }

  function selectLine(id: string) {
    const line = lyrics.select(id)
    if (!line) return
    // Freeze the outgoing take (and its prompts) before the guide is reset
    // for the new phrase.
    void finishCapture(transport.read()).then(saved => { if (!saved) capture.release() })
    capture.cancelRequest()
    review.stop()
    guide.clear()
    guide.prepare(line)
    if (transport.loop.value) transport.loop.value = line
    transport.seek(line.start)
  }

  function adjacent(direction: -1 | 1) {
    const line = lyrics.adjacent(direction)
    if (line) selectLine(line.id)
  }

  function selectSong(song: Song) {
    if (song.id === transport.song.value.id) return
    void finishCapture(transport.read()).then(saved => { if (!saved) capture.release() })
    capture.cancelRequest()
    review.stop()
    guide.clear()
    transport.setSong(song)
    lyrics.reset()
  }

  let scrubTimer = 0
  let scrubAt: number | null = null
  let scrubStop: Promise<boolean> = Promise.resolve(true)

  /**
   * A scrub during a take closes that take where the singer actually was and
   * keeps the microphone. The next take starts once the scrub settles, at the
   * spot the singer chose; the guide re-confirms there from fresh evidence.
   */
  function seek(position: number): void {
    review.stop()
    const loop = transport.loop.value
    if (loop && (position < loop.start || position >= loop.end)) transport.loop.value = null
    if (capture.status.value === 'recording') {
      window.clearTimeout(scrubTimer)
      scrubAt = position
      holdMic = true
      if (!pendingGuide) {
        pendingGuide = [...guide.endTake(transport.read())]
        keepMic = true
        scrubStop = capture.stop(transport.read(), { keepInput: true }).finally(() => { keepMic = false })
      }
      scrubTimer = window.setTimeout(() => {
        const target = scrubAt
        scrubAt = null
        if (target === null) return
        // Wait for the interrupted take to be saved before reopening, so the
        // new take never overwrites the old one's prompts.
        void scrubStop.then(async () => {
          transport.seek(target)
          await restartAt(target, 'seek')
        })
      }, 280)
      return
    }
    capture.cancelRequest()
    transport.seek(position)
    const line = lyrics.selected.value
    if (line && position >= line.start && position < line.end) guide.prepare(line)
  }

  onBeforeUnmount(() => window.clearTimeout(scrubTimer))

  function toggleLoop() {
    if (transport.loop.value) {
      transport.loop.value = null
      return
    }
    const line = lyrics.selected.value
    if (!line) return
    transport.loop.value = line
    selectLine(line.id)
  }

  /**
   * Pausing mid-take closes the take, releases the microphone and silences
   * the guide. Playing again needs an explicit record press, so the mouth is
   * never open without the singer asking for it.
   */
  function togglePlay() {
    guide.hush()
    capture.cancelRequest()
    review.stop()
    if (transport.isPlaying.value) transport.pause()
    else void transport.play()
  }

  function toggleRecording() {
    if (capture.status.value === 'recording') {
      void finishCapture(transport.read())
      return
    }
    if (capture.status.value === 'requesting') {
      capture.cancelRequest()
      return
    }
    const line = lyrics.selected.value
    if (!line || capture.status.value !== 'idle') return
    review.stop()
    transport.pause()
    pitch.clear()
    void capture.start(takeTarget(line), () => {
      transport.seek(line.start)
      return transport.play()
    })
  }

  function listen(take: Take) { void review.listen(take) }

  /** Listen to the guide's own reading of the selected phrase, no microphone. */
  function auditionGuide() {
    const line = lyrics.selected.value
    if (!line) return
    guide.audition(line, transport.isPlaying.value, transport.position.value)
  }

  // Show the entry candidates for the first phrase before any interaction.
  guide.prepare(lyrics.selected.value)
  watch(lyrics.selected, line => { if (line) guide.prepare(line) })

  watch(transport.position, position => {
    if (capture.status.value === 'recording') guide.advance(position)
    const line = lyrics.selected.value
    if (line && position >= line.end) void finishCapture(line.end)
  })

  function handleVisibility() {
    if (!document.hidden) return
    guide.hush()
    capture.cancelRequest()
    transport.pause()
  }
  onMounted(() => document.addEventListener('visibilitychange', handleVisibility))
  onBeforeUnmount(() => document.removeEventListener('visibilitychange', handleVisibility))

  return {
    transport, lyrics, pitch, review, capture, guide, graphRange, graphPosition,
    selectLine, adjacent, selectSong, seek, toggleLoop, togglePlay, toggleRecording, listen, auditionGuide,
  }
}
