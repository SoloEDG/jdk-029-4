import type { GuideNote, LyricLine, Song } from '../../../shared/document'

/** Shortest prompt worth starting: anything less is half a syllable. */
export const MIN_PROMPT = 0.3
/** Seconds at the head of a note that still belong to its consonant. */
const ATTACK_GUARD_MAX = 0.24
const ATTACK_GUARD_MIN = 0.12
/** A note this far above the previous one is entered by a leap. */
export const LEAP_SEMITONES = 5
export const EPS = 1e-4
/**
 * How late a preset may still start: one animation frame. Anything later
 * would clip the attack, so the guide falls through to the next candidate
 * instead of stitching in half a consonant.
 */
export const ON_TIME = 0.06

export type CandidateVariant = 'attack' | 'settle'
export type RejectReason = 'past' | 'truncated' | 'short' | 'leap' | 'line'

export interface EntryCandidate {
  id: string
  lineId: string
  noteIndex: number
  variant: CandidateVariant
  /** Song time where the guide would start singing this preset. */
  start: number
  /** Song time where the preset ends. */
  end: number
  midi: number
  /** Accented notes expose two distinguishable entry points. */
  accent: boolean
  /** This note is reached by a sudden jump in the melody. */
  leap: boolean
  /** Seconds from note onset to the vowel-safe entry (settle only). */
  guard: number
  complete: boolean
  incomplete?: RejectReason
}

function guardFor(note: GuideNote) {
  return Math.min(ATTACK_GUARD_MAX, Math.max(ATTACK_GUARD_MIN, (note.end - note.start) * 0.25))
}

function isAccent(note: GuideNote, position: number, line: LyricLine, beat: number) {
  if (position === 0) return true
  const relative = (note.start - line.start) / beat
  const nearest = Math.round(relative)
  if (Math.abs(relative - nearest) > 0.14) return false
  const strongBeat = ((nearest % 4) + 4) % 4 === 0
  const long = note.end - note.start >= beat * 1.5
  return strongBeat || long
}

function isLeap(note: GuideNote, previous: GuideNote | undefined) {
  return Boolean(previous && note.midi - previous.midi >= LEAP_SEMITONES)
}

/**
 * Build every entry point a guide may use for one lyric line.
 *
 * Every note offers an attack preset (from its onset). Accented notes offer a
 * second, longer-guarded settle preset that lands on the vowel. The settle
 * preset is withheld on a melodic leap so the guide never stitches in the
 * raised slice of a jump, and presets that cannot be performed in full before
 * the line ends are marked incomplete instead of being clipped.
 */
export function buildLinePlan(song: Song, line: LyricLine): LinePlan {
  const beat = 60 / song.bpm
  const inside = song.notes
    .map((note, index) => ({ note, index }))
    .filter(({ note }) => note.start >= line.start - EPS && note.start < line.end - EPS)
  const candidates: EntryCandidate[] = []

  for (const [position, { note, index }] of inside.entries()) {
    const previous = inside[position - 1]?.note
    const accent = isAccent(note, position, line, beat)
    const leap = isLeap(note, previous)
    const endsInside = note.end <= line.end + EPS
    const attackComplete = endsInside && note.end - note.start >= MIN_PROMPT

    candidates.push({
      id: `${line.id}:${index}:attack`,
      lineId: line.id,
      noteIndex: index,
      variant: 'attack',
      start: note.start,
      end: note.end,
      midi: note.midi,
      accent,
      leap,
      guard: 0,
      complete: attackComplete,
      incomplete: attackComplete ? undefined : endsInside ? 'short' : 'truncated',
    })

    if (!accent) continue
    const guard = guardFor(note)
    const settleStart = note.start + guard
    const settleFits = endsInside && note.end - settleStart >= MIN_PROMPT
    candidates.push({
      id: `${line.id}:${index}:settle`,
      lineId: line.id,
      noteIndex: index,
      variant: 'settle',
      start: settleStart,
      end: note.end,
      midi: note.midi,
      accent,
      leap,
      guard,
      complete: settleFits && !leap,
      incomplete: leap ? 'leap' : settleFits ? undefined : endsInside ? 'short' : 'truncated',
    })
  }

  candidates.sort((a, b) => a.start - b.start || (a.variant === 'attack' ? -1 : 1))
  const pickup = candidates.find(candidate => candidate.complete) ?? null
  return { songId: song.id, line, beat, candidates, pickup, notes: inside.map(entry => entry.note) }
}

export interface LinePlan {
  songId: string
  line: LyricLine
  beat: number
  candidates: EntryCandidate[]
  pickup: EntryCandidate | null
  notes: GuideNote[]
}

export interface NoteGroup {
  noteIndex: number
  midi: number
  /** Attack first, then the vowel-safe settle preset when one exists. */
  candidates: EntryCandidate[]
  attack: EntryCandidate
  settle: EntryCandidate | null
}

/** Accented notes only: the points where the guide may enter. */
export function accentGroups(plan: LinePlan): NoteGroup[] {
  const groups = new Map<number, NoteGroup>()
  for (const candidate of plan.candidates) {
    if (!candidate.accent) continue
    let group = groups.get(candidate.noteIndex)
    if (!group) {
      group = {
        noteIndex: candidate.noteIndex,
        midi: candidate.midi,
        candidates: [],
        attack: candidate,
        settle: null,
      }
      groups.set(candidate.noteIndex, group)
    }
    group.candidates.push(candidate)
    if (candidate.variant === 'attack') group.attack = candidate
    else group.settle = candidate
  }
  return [...groups.values()]
    .map(group => ({ ...group, candidates: group.candidates.sort((a, b) => a.start - b.start) }))
    .sort((a, b) => a.attack.start - b.attack.start)
}

/** First preset still ahead that can be performed in full. */
export function nextPreset(plan: LinePlan, from: number, done: ReadonlySet<number>): EntryCandidate | null {
  for (const group of accentGroups(plan)) {
    if (done.has(group.noteIndex)) continue
    for (const candidate of group.candidates) {
      if (!candidate.complete) continue
      if (candidate.start + ON_TIME < from) continue
      return candidate
    }
  }
  return null
}
