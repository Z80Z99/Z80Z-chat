import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMentionSpans, updateMentionSpans, serializeMentionText, parseMentionText, findMentionQuery, mentionChoices } from '../frontend/src/utils/message-mentions.ts'
import { readChatDraft, saveChatDraft } from '../frontend/src/utils/chat-draft.ts'
import { createMessageAttempt, messageAttemptMatches, messageAttemptKey, readMessageAttempt, saveMessageAttempt } from '../frontend/src/utils/message-attempt.ts'

class MemoryStorage {
  entries = new Map()
  getItem(key) { return this.entries.get(key) ?? null }
  setItem(key, value) { this.entries.set(key, value) }
  removeItem(key) { this.entries.delete(key) }
}
const selected = { text: '  @小明 你好 @小明  ', mentionSpans: [{ start: 2, end: 5, userId: 'one' }, { start: 9, end: 12, userId: 'two' }], replyTo: null }

test('提及序列化保存同昵称的实际身份，文字trim不改变提及偏移', () => {
  assert.deepEqual(serializeMentionText(selected.text, selected.mentionSpans), { content: '<@one> 你好 <@two>', mentions: ['one', 'two'], mentionEveryone: false })
  assert.deepEqual(serializeMentionText('@小明 未选择的文字'), { content: '@小明 未选择的文字', mentions: [], mentionEveryone: false })
  assert.deepEqual(serializeMentionText('@小明 @小明', [{ start: 0, end: 3, userId: 'one' }, { start: 4, end: 7, userId: 'one' }]).mentions, ['one'])
})

test('正常编辑、粘贴和表情插入移动跨度，修改名字或跨越名字会取消身份', () => {
  const previous = 'Hi @小明!' , span = [{ start: 3, end: 6, userId: 'one' }]
  assert.deepEqual(updateMentionSpans(previous, '🙂Hi @小明!', span), [{ start: 5, end: 8, userId: 'one' }])
  assert.deepEqual(updateMentionSpans(previous, 'Hi @小明!😀', span), span)
  assert.deepEqual(updateMentionSpans(previous, 'Hi @小新!', span), [])
  assert.deepEqual(updateMentionSpans(previous, 'Hi replacement!', span), [])
  assert.deepEqual(updateMentionSpans(previous, 'Hi x@小明!', span), [{ start: 4, end: 7, userId: 'one' }])
  assert.deepEqual(updateMentionSpans(previous, 'Hi @小明x!', span), span)
})

test('跨度只接受有效文字区间、用户ID和非交叉顺序，损坏数据不能改变文字', () => {
  assert.deepEqual(normalizeMentionSpans('@a @b', [{ start: 3, end: 5, userId: 'b' }, { start: 0, end: 2, userId: 'a' },
    { start: -1, end: 2, userId: 'x' }, { start: 0, end: 5, userId: 'overlap' }, { start: 0, end: 2, userId: '<attack>' }]), [{ start: 0, end: 2, userId: 'a' }, { start: 3, end: 5, userId: 'b' }])
  assert.equal(serializeMentionText('@a', [{ start: 0, end: 99, userId: 'b' }]).content, '@a')
})

test('everybody只识别独立@everyone，邮件或类似文本不触发全体提醒', () => {
  for (const text of ['@everyone', '你好，@everyone。', '(@everyone)', 'Hi @everyone!']) assert.equal(serializeMentionText(text).mentionEveryone, true)
  for (const text of ['a@everyone.com', '@everyoneElse', 'x@everyone']) assert.equal(serializeMentionText(text).mentionEveryone, false)
  assert.equal(serializeMentionText('@所有成员', [{ start: 0, end: 5, userId: 'everyone' }]).content, '@everyone')
})

test('编辑canonical提及显示昵称并保留原身份，包括已离开的成员', () => {
  const result = parseMentionText('hello <@one> <@missing>', [{ id: 'one', username: 'Alice', nickname: '小明' }])
  assert.equal(result.text, 'hello @小明 @已离开的成员')
  assert.deepEqual(serializeMentionText(result.text, result.mentionSpans), { content: 'hello <@one> <@missing>', mentions: ['one', 'missing'], mentionEveryone: false })
})

test('提及查询跟随光标和选区，不在已选成员、电子邮件和下一单词中打开', () => {
  assert.deepEqual(findMentionQuery('Hi @小', 5), { start: 3, end: 5, query: '小' })
  assert.deepEqual(findMentionQuery('@', 1), { start: 0, end: 1, query: '' })
  assert.equal(findMentionQuery('@name', 2, 5), null)
  assert.equal(findMentionQuery('email@name', 10), null)
  assert.equal(findMentionQuery('@name hello', 11), null)
  assert.equal(findMentionQuery('@小明', 3, 3, [{ start: 0, end: 3, userId: 'one' }]), null)
})

test('候选查询支持昵称和用户名，同时可分辨同昵称身份及全体权限', () => {
  const users = [{ id: 'one', username: 'Alice', nickname: '小明' }, { id: 'two', username: 'Bob', nickname: '小明' }]
  assert.deepEqual(mentionChoices(users, '小', false).map(user => user.id), ['one', 'two'])
  assert.deepEqual(mentionChoices(users, 'ali', false).map(user => user.id), ['one'])
  assert.equal(mentionChoices(users, 'every', false).length, 0)
  assert.equal(mentionChoices(users, 'every', true)[0].id, 'everyone')
})

test('带身份的草稿和发送尝试跨刷新恢复，指纹包含同昵称不同身份', () => {
  const storage = new MemoryStorage()
  assert.equal(saveChatDraft(storage, 'user', 'channel', selected), true)
  assert.deepEqual(readChatDraft(storage, 'user', 'channel'), selected)
  const serialized = serializeMentionText(selected.text, selected.mentionSpans)
  const payload = { channelId: 'channel', content: serialized.content, mentions: serialized.mentions, replyTo: null }
  const attempt = createMessageAttempt(payload, selected, null)
  assert.equal(saveMessageAttempt(storage, 'user', 'channel', attempt), true)
  assert.equal(readMessageAttempt(storage, 'user', 'channel').clientMessageId, attempt.clientMessageId)
  assert.equal(messageAttemptMatches(attempt, payload, selected), true)
  const changed = { ...selected, mentionSpans: [{ start: 2, end: 5, userId: 'two' }, { start: 9, end: 12, userId: 'one' }] }
  assert.equal(messageAttemptMatches(attempt, payload, changed), false)
  assert.equal(saveMessageAttempt(storage, 'user', 'channel', { ...attempt, payload: { ...payload, mentions: ['other'] } }), false)
})

test('旧六字段未确认尝试升级保留原提交ID和原payload，不重新创建消息', () => {
  const storage = new MemoryStorage()
  const payload = { channelId: 'channel', content: 'Hi @everyone', replyTo: null }
  const draft = { text: payload.content, replyTo: null }
  const old = createMessageAttempt(payload, draft, null)
  storage.setItem(messageAttemptKey('user', 'channel'), JSON.stringify(old))
  const restored = readMessageAttempt(storage, 'user', 'channel')
  assert.equal(restored.clientMessageId, old.clientMessageId)
  assert.deepEqual(restored.payload, payload)
  assert.equal(messageAttemptMatches(restored, { ...payload, mentionEveryone: true }, draft), true)
  assert.equal(messageAttemptMatches(restored, { ...payload, mentions: ['different'] }, draft), false)
})

test('输入选区精确区分重复同名标签删除、粘贴和向后删除', () => {
  const previous = '@小明 @小明', spans = [{ start: 0, end: 3, userId: 'one' }, { start: 4, end: 7, userId: 'two' }]
  assert.deepEqual(updateMentionSpans(previous, '@小明', spans, { text: previous, start: 0, end: 4, inputType: 'deleteByCut' }), [{ start: 0, end: 3, userId: 'two' }])
  assert.deepEqual(updateMentionSpans(previous, '@小明', spans, { text: previous, start: 4, end: 4, inputType: 'deleteWordBackward' }), [{ start: 0, end: 3, userId: 'two' }])
  assert.deepEqual(updateMentionSpans(previous, '@小明 @小明', spans, { text: previous, start: 0, end: 3, inputType: 'insertFromPaste' }), [{ start: 4, end: 7, userId: 'two' }])
  assert.deepEqual(updateMentionSpans(previous, '复制文字 @小明', spans, { text: previous, start: 0, end: 3, inputType: 'insertFromPaste' }), [{ start: 5, end: 8, userId: 'two' }])
})

test('没有可靠选区或undo时丢弃同名身份歧义，不将第一人误保留为第二人', () => {
  const previous = '@小明 @小明', spans = [{ start: 0, end: 3, userId: 'one' }, { start: 4, end: 7, userId: 'two' }]
  assert.deepEqual(updateMentionSpans(previous, '@小明', spans), [])
  assert.deepEqual(updateMentionSpans(previous, '@小明', spans, { text: previous, start: 0, end: 4, inputType: 'historyUndo' }), [])
  assert.deepEqual(updateMentionSpans(previous, '@小明', spans, { text: 'stale', start: 0, end: 4, inputType: 'deleteByCut' }), [])
})
