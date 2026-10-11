/** Identifies the account and room that own an asynchronous media operation. */
export interface VoiceSessionToken {
  generation: number
  roomId: string | null
  userId: string
  token: string | null
}

export interface VoiceSignalMessage {
  type: string
  roomId: string | null
  targetUserId?: string
  data?: unknown
}
