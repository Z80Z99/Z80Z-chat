export type VoiceMode = 'open' | 'push-to-talk'

export interface VoicePreferences {
  voiceMode: VoiceMode
  pushToTalkKey: string
  outputVolume: number
  userVolumes: Record<string, number>
}

export function clampVoiceVolume(value: unknown, fallback = 1): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback
}

export function validPushToTalkKey(value: unknown): string {
  return isPushToTalkKey(value) ? value : 'Space'
}

export function normalizeVoicePreferences(value: unknown): VoicePreferences {
  const source = value && typeof value === 'object' ? value as Partial<VoicePreferences> : {}
  const userVolumes: Record<string, number> = Object.create(null)
  if (source.userVolumes && typeof source.userVolumes === 'object' && !Array.isArray(source.userVolumes)) {
    for (const [id, volume] of Object.entries(source.userVolumes).slice(0, 1000)) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || id === '__proto__' || id === 'constructor' || id === 'prototype') continue
      userVolumes[id] = clampVoiceVolume(volume)
    }
  }
  return {
    voiceMode: source.voiceMode === 'push-to-talk' ? 'push-to-talk' : 'open',
    pushToTalkKey: validPushToTalkKey(source.pushToTalkKey),
    outputVolume: clampVoiceVolume(source.outputVolume), userVolumes
  }
}

export function voicePreferencesKey(userId: string): string {
  return `z80z-chat_voice_preferences_${userId}`
}
import { isPushToTalkKey } from './push-to-talk'
