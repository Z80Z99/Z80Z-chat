export type ScreenPlaybackStatus = 'waiting' | 'loading' | 'playing' | 'paused' | 'blocked' | 'stalled' | 'ended' | 'error'

export interface ScreenPlaybackState {
  status: ScreenPlaybackStatus
  paused: boolean
  width: number
  height: number
  fps: number | null
  framesPresented: number | null
  currentTime: number
}
