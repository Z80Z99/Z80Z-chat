import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_DRAFT_LENGTH } from '../frontend/src/utils/chat-draft.ts'
import { createMessageAttempt, messageAttemptKey, messageAttemptMatches, messagePayloadFingerprint, readMessageAttempt, saveMessageAttempt, clearMessageAttempt } from '../frontend/src/utils/message-attempt.ts'

class MemoryStorage {
  entries = new Map()
  getItem(key) { return this.entries.get(key) ?? null }
  setItem(key, value) { this.entries.set(key, value) }
  removeItem(key) { this.entries.delete(key) }
}

test('提交尝试编号唯一且符合后端格式，指纹覆盖文字、回复和附件', () => {
  const payload = { channelId: 'channel', content: 'hello', replyTo: null }
  const draft = { text: ' hello ', replyTo: null }
  const first = createMessageAttempt(payload, draft, null)
  const second = createMessageAttempt(payload, draft, null)
  assert.match(first.clientMessageId, /^[a-zA-Z0-9_-]{1,128}$/)
  assert.notEqual(first.clientMessageId, second.clientMessageId)
  assert.equal(messageAttemptMatches(first, payload, draft), true)
  assert.equal(messageAttemptMatches(first, { ...payload, content: 'edited' }, { ...draft, text: 'edited' }), false)
  assert.equal(messageAttemptMatches(first, { ...payload, replyTo: 'reply' }, draft), false)
  assert.equal(messageAttemptMatches(first, { ...payload, image: '/uploads/new.png' }, draft), false)
  assert.equal(messageAttemptMatches(first, payload, { ...draft, text: 'hello' }), false)
  assert.notEqual(messagePayloadFingerprint({ ...payload, file: '/uploads/a.txt', fileName: 'a.txt' }), messagePayloadFingerprint({ ...payload, file: '/uploads/a.txt', fileName: 'b.txt' }))
})

test('未确认尝试按账号频道保存，附件仅保留已上传 URL 与元信息', () => {
  const storage = new MemoryStorage()
  const payload = { channelId: 'channel', content: 'image', replyTo: null, image: '/uploads/a.png?expires=1&sig=abc' }
  const attempt = createMessageAttempt(payload, { text: 'image', replyTo: null }, { kind: 'image', url: payload.image, name: 'a.png', size: 1024 })
  attempt.attachment.preview = 'blob:private'
  attempt.attachment.file = { secret: 'file bytes' }
  assert.equal(saveMessageAttempt(storage, 'user-a', 'channel', attempt), true)
  const restored = readMessageAttempt(storage, 'user-a', 'channel')
  assert.equal(restored.clientMessageId, attempt.clientMessageId)
  assert.deepEqual(restored.attachment, { kind: 'image', url: payload.image, name: 'a.png', size: 1024 })
  assert.ok(!storage.getItem(messageAttemptKey('user-a', 'channel')).includes('blob:'))
  assert.ok(!storage.getItem(messageAttemptKey('user-a', 'channel')).includes('file bytes'))
  assert.equal(readMessageAttempt(storage, 'user-b', 'channel'), null)
  assert.equal(readMessageAttempt(storage, 'user-a', 'other'), null)
  assert.equal(clearMessageAttempt(storage, 'user-a', 'channel', 'another-id'), true)
  assert.equal(readMessageAttempt(storage, 'user-a', 'channel').clientMessageId, attempt.clientMessageId)
  assert.equal(clearMessageAttempt(storage, 'user-a', 'channel', attempt.clientMessageId), true)
  assert.equal(readMessageAttempt(storage, 'user-a', 'channel'), null)
})

test('损坏、被改动或不匹配的尝试不能被恢复为旧编号', () => {
  const storage = new MemoryStorage()
  const key = messageAttemptKey('user', 'channel')
  const payload = { channelId: 'channel', content: 'hello', replyTo: null }
  const original = createMessageAttempt(payload, { text: 'hello', replyTo: null }, null)
  for (const update of [
    { clientMessageId: 123 },
    { clientMessageId: 'invalid id' },
    { fingerprint: 'not the original payload' },
    { payload: { ...payload, channelId: 'other' } },
    { draft: { text: 'edited', replyTo: null } },
    { attachment: { kind: 'image', url: 'blob:not-uploaded', name: 'a.png', size: 1024 } }
  ]) {
    storage.setItem(key, JSON.stringify({ ...original, ...update }))
    assert.equal(readMessageAttempt(storage, 'user', 'channel'), null)
  }
  storage.setItem(key, '{broken json')
  assert.equal(readMessageAttempt(storage, 'user', 'channel'), null)
  assert.equal(saveMessageAttempt(storage, 'user', 'channel', { ...original, draft: { text: 'different', replyTo: null } }), false)
})

test('存储异常安全，最大长度含转义字符的原 payload 可完整恢复', () => {
  const unavailable = { getItem() { throw new Error('denied') }, setItem() { throw new Error('quota') }, removeItem() { throw new Error('denied') } }
  const content = '\u0001'.repeat(MAX_DRAFT_LENGTH)
  const attempt = createMessageAttempt({ channelId: 'channel', content, replyTo: null }, { text: content, replyTo: null }, null)
  assert.equal(readMessageAttempt(unavailable, 'user', 'channel'), null)
  assert.equal(saveMessageAttempt(unavailable, 'user', 'channel', attempt), false)
  assert.equal(clearMessageAttempt(unavailable, 'user', 'channel', attempt.clientMessageId), false)
  const storage = new MemoryStorage()
  assert.equal(saveMessageAttempt(storage, 'user', 'channel', attempt), true)
  assert.equal(readMessageAttempt(storage, 'user', 'channel').payload.content, content)
})
