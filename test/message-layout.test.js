import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldGroupMessages, sameMessageDay, appendedMessageIds, isNearMessageBottom } from '../frontend/src/utils/message-layout.ts'

const message = (fields = {}) => ({ userId: 'u', channelId: 'c', createdAt: '2026-10-09T12:00:00', replyTo: null, ...fields })

test('同作者同频道五分钟内消息合并，首条和不同身份不合并', () => {
  assert.equal(shouldGroupMessages(message(), message({ createdAt: '2026-10-09T12:04:59' })), true)
  assert.equal(shouldGroupMessages(undefined, message()), false)
  assert.equal(shouldGroupMessages(message(), message({ userId: 'other' })), false)
  assert.equal(shouldGroupMessages(message(), message({ channelId: 'other' })), false)
})

test('跨日、回复、无效时间、倒序和五分钟边界打断分组', () => {
  assert.equal(shouldGroupMessages(message({ createdAt: '2026-10-09T23:59:00' }), message({ createdAt: '2026-10-10T00:00:00' })), false)
  assert.equal(shouldGroupMessages(message(), message({ replyTo: 'reply' })), false)
  assert.equal(shouldGroupMessages(message({ replyTo: 'reply' }), message()), false)
  assert.equal(shouldGroupMessages(message(), message({ createdAt: 'invalid' })), false)
  assert.equal(shouldGroupMessages(message(), message({ createdAt: '2026-10-09T11:59:00' })), false)
  assert.equal(shouldGroupMessages(message(), message({ createdAt: '2026-10-09T12:05:00' })), false)
  assert.equal(sameMessageDay('invalid', 'invalid'), false)
})

test('历史分页不计为新消息，同时新增历史和末尾消息只计末尾', () => {
  assert.deepEqual(appendedMessageIds(['b', 'c'], ['a', 'b', 'c']), [])
  assert.deepEqual(appendedMessageIds(['b', 'c'], ['a', 'b', 'c', 'd']), ['d'])
  assert.deepEqual(appendedMessageIds(['b', 'c'], ['b', 'c']), [])
})

test('初次加载和列表替换不显示虚假的新消息数量', () => {
  assert.deepEqual(appendedMessageIds([], ['a', 'b']), [])
  assert.deepEqual(appendedMessageIds(['a', 'b'], ['x', 'y']), [])
})

test('距底部超过阈值时不自动跟随，短列表视为底部', () => {
  assert.equal(isNearMessageBottom(120, 400, 600), true)
  assert.equal(isNearMessageBottom(119, 400, 600), false)
  assert.equal(isNearMessageBottom(0, 400, 200), true)
})
