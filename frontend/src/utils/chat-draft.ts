import { normalizeMentionSpans } from './message-mentions.ts'
import type { MentionSpan } from './message-mentions'
export const MAX_DRAFT_LENGTH = 10000

export interface DraftReply {
  id: string
  content: string
  username: string
}

export interface ChatDraft {
  text: string
  replyTo: DraftReply | null
  mentionSpans?: MentionSpan[]
}

export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function chatDraftKey(userId: string, channelId: string) {
  return `z80z:chat-draft:v1:${encodeURIComponent(userId)}:${encodeURIComponent(channelId)}`
}

function normalizeDraft(value: any): ChatDraft {
  const reply = value?.replyTo
  const text = typeof value?.text === 'string' ? value.text.slice(0, MAX_DRAFT_LENGTH) : ''
  const mentionSpans = normalizeMentionSpans(text, value?.mentionSpans)
  return {
    text,
    ...(mentionSpans.length ? { mentionSpans } : {}),
    replyTo: reply && typeof reply.id === 'string' && reply.id && typeof reply.content === 'string' && typeof reply.username === 'string'
      ? { id: reply.id.slice(0, 128), content: reply.content.slice(0, 100), username: reply.username.slice(0, 80) }
      : null
  }
}

export function readChatDraft(storage: DraftStorage | null, userId: string, channelId: string): ChatDraft {
  try {
    const raw = storage?.getItem(chatDraftKey(userId, channelId))
    if (!raw || raw.length > MAX_DRAFT_LENGTH * 6 + 50000) return { text: '', replyTo: null }
    return normalizeDraft(JSON.parse(raw))
  } catch {
    return { text: '', replyTo: null }
  }
}

export function saveChatDraft(storage: DraftStorage | null, userId: string, channelId: string, value: ChatDraft): boolean {
  if (!storage) return false
  try {
    const draft = normalizeDraft(value)
    const key = chatDraftKey(userId, channelId)
    if (!draft.text && !draft.replyTo) storage.removeItem(key)
    else storage.setItem(key, JSON.stringify(draft))
    return true
  } catch {
    return false
  }
}
