import { MAX_DRAFT_LENGTH } from './chat-draft.ts'
import type { ChatDraft, DraftStorage } from './chat-draft'
import { normalizeMentionSpans, serializeMentionText } from './message-mentions.ts'

export interface AttemptPayload {
  channelId: string
  content: string
  replyTo: string | null
  image?: string
  file?: string
  fileName?: string
  mentions?: string[]
  mentionEveryone?: boolean
}

export interface AttemptAttachment {
  kind: 'image' | 'file'
  url: string
  name: string
  size: number
}

export interface MessageAttempt {
  clientMessageId: string
  fingerprint: string
  payload: AttemptPayload
  draft: ChatDraft
  attachment: AttemptAttachment | null
}

export function messageAttemptKey(userId: string, channelId: string) {
  return `z80z:message-attempt:v1:${encodeURIComponent(userId)}:${encodeURIComponent(channelId)}`
}

export function messagePayloadFingerprint(payload: AttemptPayload) {
  const values: any[] = [payload.channelId, payload.content, payload.replyTo, payload.image || null, payload.file || null, payload.fileName || null]
  if (payload.mentions?.length || payload.mentionEveryone) values.push(payload.mentions || [], !!payload.mentionEveryone)
  return JSON.stringify(values)
}

export function messageAttemptMatches(attempt: MessageAttempt, payload: AttemptPayload, draft: ChatDraft) {
  const legacy = !attempt.payload.mentions && attempt.payload.mentionEveryone === undefined
    && !draft.mentionSpans?.length && !payload.mentions?.length
  return (attempt.fingerprint === messagePayloadFingerprint(payload)
    || (legacy && attempt.fingerprint === messagePayloadFingerprint({ ...payload, mentions: undefined, mentionEveryone: undefined })))
    && attempt.draft.text === draft.text
    && attempt.draft.replyTo?.id === draft.replyTo?.id
    && JSON.stringify(normalizeMentionSpans(draft.text, attempt.draft.mentionSpans)) === JSON.stringify(normalizeMentionSpans(draft.text, draft.mentionSpans))
}

let fallbackSequence = 0
function createClientMessageId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  if (globalThis.crypto?.getRandomValues) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
  }
  // A compatibility fallback for older browsers; these IDs are not credentials.
  return `${Date.now().toString(36)}-${++fallbackSequence}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

export function createMessageAttempt(payload: AttemptPayload, draft: ChatDraft, attachment: AttemptAttachment | null): MessageAttempt {
  return {
    clientMessageId: createClientMessageId(),
    fingerprint: messagePayloadFingerprint(payload),
    payload: { ...payload, ...(payload.mentions?.length ? { mentions: [...payload.mentions] } : {}) },
    draft: { text: draft.text, replyTo: draft.replyTo ? { ...draft.replyTo } : null, ...(draft.mentionSpans?.length ? { mentionSpans: normalizeMentionSpans(draft.text, draft.mentionSpans) } : {}) },
    attachment: attachment ? { ...attachment } : null
  }
}

function validText(value: any, limit: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= limit && (allowEmpty || value.length > 0)
}

function validateAttempt(value: any, channelId: string): MessageAttempt | null {
  if (!value || !validText(value.clientMessageId, 128) || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.clientMessageId)) return null
  const payload = value.payload
  const draft = value.draft
  if (!payload || payload.channelId !== channelId || !validText(channelId, 128)
    || !validText(payload.content, MAX_DRAFT_LENGTH, true)
    || !(payload.replyTo === null || validText(payload.replyTo, 128))
    || !draft || !validText(draft.text, MAX_DRAFT_LENGTH, true)) return null
  const mentionSpans = normalizeMentionSpans(draft.text, draft.mentionSpans)
  const serialized = serializeMentionText(draft.text, mentionSpans)
  if (serialized.content !== payload.content) return null
  if (payload.mentions !== undefined && (!Array.isArray(payload.mentions)
    || JSON.stringify(payload.mentions) !== JSON.stringify(serialized.mentions))) return null
  if (serialized.mentions.length && payload.mentions === undefined) return null
  if (payload.mentionEveryone !== undefined && (typeof payload.mentionEveryone !== 'boolean' || payload.mentionEveryone !== serialized.mentionEveryone)) return null
  if (mentionSpans.some(span => span.userId === 'everyone') && !payload.mentionEveryone) return null
  if (draft.replyTo !== null && (!draft.replyTo || draft.replyTo.id !== payload.replyTo
    || !validText(draft.replyTo.content, 100, true) || !validText(draft.replyTo.username, 80, true))) return null
  if ((draft.replyTo?.id || null) !== payload.replyTo) return null

  const cleanPayload: AttemptPayload = { channelId, content: payload.content, replyTo: payload.replyTo }
  if (payload.mentions !== undefined) cleanPayload.mentions = [...payload.mentions]
  if (payload.mentionEveryone !== undefined) cleanPayload.mentionEveryone = payload.mentionEveryone
  let attachment: AttemptAttachment | null = null
  if (value.attachment !== null) {
    const item = value.attachment
    if (!item || !['image', 'file'].includes(item.kind) || !validText(item.url, 4096) || !item.url.startsWith('/uploads/')
      || !validText(item.name, 1024) || !Number.isSafeInteger(item.size) || item.size < 0) return null
    attachment = { kind: item.kind, url: item.url, name: item.name, size: item.size }
    if (item.kind === 'image') {
      if (payload.image !== item.url || payload.file || payload.fileName) return null
      cleanPayload.image = item.url
    } else {
      if (payload.file !== item.url || payload.image || !validText(payload.fileName, 1024)) return null
      cleanPayload.file = item.url
      cleanPayload.fileName = payload.fileName
    }
  } else if (payload.image || payload.file || payload.fileName) return null
  if (!payload.content && !attachment) return null
  if (value.fingerprint !== messagePayloadFingerprint(cleanPayload)) return null
  return {
    clientMessageId: value.clientMessageId,
    fingerprint: value.fingerprint,
    payload: cleanPayload,
    draft: { text: draft.text, replyTo: draft.replyTo ? { id: payload.replyTo!, content: draft.replyTo.content, username: draft.replyTo.username } : null, ...(mentionSpans.length ? { mentionSpans } : {}) },
    attachment
  }
}

export function readMessageAttempt(storage: DraftStorage | null, userId: string, channelId: string): MessageAttempt | null {
  try {
    const raw = storage?.getItem(messageAttemptKey(userId, channelId))
    if (!raw || raw.length > MAX_DRAFT_LENGTH * 18 + 60000) return null
    return validateAttempt(JSON.parse(raw), channelId)
  } catch {
    return null
  }
}

export function saveMessageAttempt(storage: DraftStorage | null, userId: string, channelId: string, attempt: MessageAttempt): boolean {
  if (!storage) return false
  try {
    const clean = validateAttempt(attempt, channelId)
    if (!clean) return false
    storage.setItem(messageAttemptKey(userId, channelId), JSON.stringify(clean))
    return true
  } catch {
    return false
  }
}

export function clearMessageAttempt(storage: DraftStorage | null, userId: string, channelId: string, expectedId?: string): boolean {
  if (!storage) return false
  try {
    const key = messageAttemptKey(userId, channelId)
    if (expectedId) {
      const raw = storage.getItem(key)
      if (!raw || validateAttempt(JSON.parse(raw), channelId)?.clientMessageId !== expectedId) return true
    }
    storage.removeItem(key)
    return true
  } catch {
    return false
  }
}
