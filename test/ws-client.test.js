import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../frontend/src/utils/ws.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText

function createClient() {
  const sockets = []
  const timers = new Map()
  let nextTimer = 0

  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3
    readyState = FakeWebSocket.CONNECTING
    onopen = null
    onmessage = null
    onclose = null
    onerror = null
    sent = []
    closeCount = 0

    constructor(url) {
      this.url = url
      sockets.push(this)
    }

    open() {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    }

    message(data) {
      this.onmessage?.({ data: JSON.stringify(data) })
    }

    send(data) {
      assert.equal(this.readyState, FakeWebSocket.OPEN)
      this.sent.push(JSON.parse(data))
    }

    close() {
      this.closeCount++
      this.readyState = FakeWebSocket.CLOSED
      this.onclose?.()
    }
  }

  const context = {
    exports: {},
    WebSocket: FakeWebSocket,
    window: { location: { protocol: 'https:', host: 'chat.example.test' } },
    console,
    setTimeout(callback, delay) {
      const id = nextTimer++
      timers.set(id, { callback, delay })
      return id
    },
    clearTimeout(id) { timers.delete(id) }
  }
  vm.runInNewContext(compiled, context, { filename: 'ws.ts' })

  function runTimer() {
    const [id, timer] = timers.entries().next().value
    timers.delete(id)
    timer.callback()
  }

  return { client: context.exports.ws, sockets, timers, runTimer }
}

test('连接建立前排队，重复 connect 不重复创建或发送', () => {
  const { client, sockets } = createClient()
  client.connect('token+a&b')
  client.send({ type: 'join-channel', channelId: 'a' })
  client.connect('token+a&b')
  assert.equal(sockets.length, 1)
  assert.equal(sockets[0].url, 'wss://chat.example.test/ws?token=token%2Ba%26b')

  sockets[0].open()
  client.connect('token+a&b')
  assert.equal(sockets.length, 1)
  assert.deepEqual(sockets[0].sent, [{ type: 'join-channel', channelId: 'a' }])
})

test('连接状态同步通知有效打开、意外断线和主动注销，卸载后不再回调', () => {
  const { client, sockets, runTimer } = createClient()
  const changes = []
  const listener = value => changes.push(value)
  client.onConnectionChange(listener)
  assert.equal(client.isConnected(), false)
  client.connect('token')
  sockets[0].open()
  assert.equal(client.isConnected(), true)
  sockets[0].close()
  assert.equal(client.isConnected(), false)
  runTimer(); sockets[1].open()
  client.disconnect()
  assert.deepEqual(changes, [false, true, false, true, false])
  client.offConnectionChange(listener)
  client.connect('new-token'); sockets[2].open()
  assert.equal(changes.length, 5)
})

test('状态监听中注销阻止旧连接重连回调和排队发送，晚到关闭不污染新会话', () => {
  const { client, sockets, timers } = createClient()
  let reconnects = 0
  client.onReconnect(() => reconnects++)
  client.connect('token'); sockets[0].open(); sockets[0].close()
  client.send({ type: 'voice-join', roomId: 'old' })
  client.onConnectionChange(connected => { if (connected) client.disconnect() })
  const timer = timers.values().next().value
  timer.callback()
  const oldClose = sockets[1].onclose
  sockets[1].open()
  assert.equal(reconnects, 0)
  assert.deepEqual(sockets[1].sent, [])
  oldClose()
  assert.equal(client.isConnected(), false)
})

test('主动断开取消重连，忽略已排入事件队列的回调', () => {
  const { client, sockets, timers } = createClient()
  let received = 0
  let reconnected = 0
  client.on('message', () => received++)
  client.onReconnect(() => reconnected++)
  client.connect('old-token')
  const old = sockets[0]
  const callbacks = { open: old.onopen, message: old.onmessage, close: old.onclose, error: old.onerror }
  client.send({ type: 'message', content: 'old queued message' })

  client.disconnect()
  assert.equal(old.closeCount, 1)
  assert.equal(old.onclose, null)
  callbacks.open()
  callbacks.message({ data: JSON.stringify({ type: 'message' }) })
  callbacks.close()
  callbacks.error()
  assert.equal(timers.size, 0)
  assert.equal(received, 0)
  assert.equal(sockets.length, 1)

  client.send({ type: 'message', content: 'sent after logout' })
  client.connect('new-token')
  sockets[1].open()
  assert.deepEqual(sockets[1].sent, [])
  assert.equal(reconnected, 0, '新会话的首次连接不属于重连')
})

test('意外断线保留当前会话队列并在 3 秒后重连一次', () => {
  const { client, sockets, timers, runTimer } = createClient()
  let reconnected = 0
  client.onReconnect(() => reconnected++)
  client.connect('token')
  sockets[0].open()
  sockets[0].close()
  client.send({ type: 'join-channel', channelId: 'a' })

  assert.equal(timers.size, 1)
  assert.equal(timers.values().next().value.delay, 3000)
  runTimer()
  assert.equal(timers.size, 0)
  assert.equal(sockets.length, 2)
  sockets[1].open()
  assert.equal(reconnected, 1)
  assert.deepEqual(sockets[1].sent, [{ type: 'join-channel', channelId: 'a' }])
})

test('主动断开清除计时器，过时重连任务不能干扰新会话', () => {
  const { client, sockets, timers } = createClient()
  client.connect('old-token')
  sockets[0].open()
  sockets[0].close()
  const staleTimer = timers.values().next().value.callback
  client.disconnect()
  assert.equal(timers.size, 0, '包括句柄为 0 的计时器也必须清除')

  client.connect('new-token')
  sockets[1].open()
  staleTimer()
  assert.equal(sockets.length, 2)
  assert.equal(sockets[1].closeCount, 0)
  assert.equal(timers.size, 0)
})

test('替换 token 清理旧会话消息和延迟事件，不关闭新连接', () => {
  const { client, sockets, timers } = createClient()
  const received = []
  let reconnected = 0
  client.onReconnect(() => reconnected++)
  client.connect('old-token')
  const old = sockets[0]
  old.open()
  old.message({ type: 'late-event', owner: 'old' })
  const stale = { open: old.onopen, message: old.onmessage, close: old.onclose, error: old.onerror }
  old.close()
  client.send({ type: 'message', content: 'old' })

  client.connect('new-token')
  client.on('late-event', data => received.push(data.owner))
  client.send({ type: 'message', content: 'new' })
  const current = sockets[1]
  stale.open()
  stale.message({ data: JSON.stringify({ type: 'late-event', owner: 'stale' }) })
  stale.close()
  stale.error()
  assert.equal(current.closeCount, 0)
  assert.equal(timers.size, 0)

  current.open()
  current.message({ type: 'late-event', owner: 'new' })
  assert.deepEqual(received, ['new'])
  assert.deepEqual(current.sent, [{ type: 'message', content: 'new' }])
  assert.equal(reconnected, 0)
})

test('token 在连接中替换时关闭旧 socket 并忽略旧 socket 打开事件', () => {
  const { client, sockets, timers } = createClient()
  client.connect('old-token')
  const old = sockets[0]
  const staleOpen = old.onopen
  client.send({ type: 'message', content: 'old' })
  client.connect('new-token')
  assert.equal(old.closeCount, 1)
  assert.equal(old.onopen, null)

  client.send({ type: 'message', content: 'new' })
  staleOpen()
  sockets[1].open()
  assert.deepEqual(sockets[0].sent, [])
  assert.deepEqual(sockets[1].sent, [{ type: 'message', content: 'new' }])
  assert.equal(timers.size, 0)
})

test('延迟消息回调切换会话后不继续派发旧会话消息', () => {
  const { client, sockets } = createClient()
  client.connect('old-token')
  sockets[0].open()
  sockets[0].message({ type: 'late-event', id: 1 })
  sockets[0].message({ type: 'late-event', id: 2 })
  const received = []
  client.on('late-event', data => {
    received.push(data.id)
    client.connect('new-token')
  })
  assert.deepEqual(received, [1])
  assert.equal(sockets.length, 2)
})

test('重连回调结束会话后不把待发消息送入新会话', () => {
  const { client, sockets, runTimer } = createClient()
  client.connect('old-token')
  sockets[0].open()
  sockets[0].close()
  client.send({ type: 'message', content: 'old' })
  client.onReconnect(() => client.connect('new-token'))
  runTimer()
  sockets[1].open()
  sockets[2].open()
  assert.deepEqual(sockets[1].sent, [])
  assert.deepEqual(sockets[2].sent, [])
})
