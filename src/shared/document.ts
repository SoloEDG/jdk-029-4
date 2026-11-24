export interface TimeRange { start: number; end: number }

export interface LyricLine extends TimeRange {
  id: string
  text: string
}

export interface GuideNote extends TimeRange { midi: number }

export interface Song {
  id: string
  title: string
  artist: string
  bpm: number
  key: string
  duration: number
  audio: string
  cover: string
  lines: LyricLine[]
  notes: GuideNote[]
}

export interface PitchPoint {
  time: number
  midi: number | null
}

export type GuideEventKind = 'pickup' | 'cue' | 'yield' | 'miss' | 'skip' | 'reset'

export type GuideReason =
  | 'start' | 'seek' | 'loop' | 'jump'
  | 'missed' | 'truncated' | 'leap' | 'short' | 'yield' | 'end' | 'ambiguous'
  | 'line' | 'past'

/** One audible or diagnostic decision made by the guide. Times are song seconds. */
export interface GuideEvent {
  id: string
  kind: GuideEventKind
  at: number
  pass: number
  lineId: string
  reason?: GuideReason
  candidateId?: string
  noteIndex?: number
  midi?: number
  start?: number
  end?: number
  variant?: 'attack' | 'settle'
  detail?: string
}

export interface Take extends TimeRange {
  id: string
  songId: string
  lineId: string
  createdAt: number
  audio: Blob
  pitch: PitchPoint[]
  /** Cues actually played for this take, kept for faithful review playback. */
  guide?: GuideEvent[]
}

export interface PcmFrame {
  inputTime: number
  samples: Float32Array
}
