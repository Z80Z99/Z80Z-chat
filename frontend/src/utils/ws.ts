type WSCallback = (data: any) => void

class WSClient {
  private ws: WebSocket | null = null
  private listeners: Map<string, WSCallback[]> = new Map()
  private reconnectTimer: any = null
  private url: string = ''
  private active = false
  private connectionId = 0
  private pending: { type: string; data: any }[] = []
  private sendQueue: any[] = []
  private hasConnectedBefore = false
  private reconnectCallbacks: (() => void)[] = []
  private connectionCallbacks: ((connected: boolean) => void)[] = []
  private connected = false

  isConnected() { return this.connected }

  private setConnected(connected: boolean) {
    if (this.connected === connected) return
    this.connected = connected
    const connectionId = this.connectionId
    for (const callback of [...this.connectionCallbacks]) {
      if (connectionId !== this.connectionId || this.connected !== connected) return
      try { callback(connected) } catch (error) { console.error('WS connection listener error:', error) }
    }
  }

  onConnectionChange(callback: (connected: boolean) => void) {
    if (!this.connectionCallbacks.includes(callback)) this.connectionCallbacks.push(callback)
    callback(this.connected)
  }

  offConnectionChange(callback: (connected: boolean) => void) {
    this.connectionCallbacks = this.connectionCallbacks.filter(item => item !== callback)
  }

  connect(token: string) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`
    if (!this.active || this.url !== url) {
      this.disconnect()
      this.url = url
      this.active = true
    }
    this.createConnection()
  }

  private createConnection() {
    if (!this.active) return

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    if (this.ws) {
      const old = this.ws
      old.onopen = null
      old.onmessage = null
      old.onclose = null
      old.onerror = null
      old.close()
    }

    const socket = new WebSocket(this.url)
    const connectionId = ++this.connectionId
    this.ws = socket
    // A previous socket may already have queued an event when it is replaced.
    const isCurrent = () => this.active && this.ws === socket && this.connectionId === connectionId

    socket.onopen = () => {
      if (!isCurrent()) return
      this.setConnected(true)
      if (!isCurrent()) return
      if (this.hasConnectedBefore) {
        for (const cb of this.reconnectCallbacks) {
          if (!isCurrent()) return
          cb()
        }
      }
      if (!isCurrent()) return
      this.hasConnectedBefore = true
      const queued = this.sendQueue
      this.sendQueue = []
      for (const data of queued) {
        if (!isCurrent()) return
        this.send(data)
      }
    }

    socket.onmessage = (event) => {
      if (!isCurrent()) return
      try {
        const data = JSON.parse(event.data)
        const type = data.type
        const cbs = this.listeners.get(type) || []
        if (cbs.length === 0 && (this.listeners.get('*') || []).length === 0) {
          this.pending.push({ type, data })
          if (this.pending.length > 100) {
            this.pending.shift()
          }
          return
        }
        for (const cb of cbs) {
          if (!isCurrent()) return
          cb(data)
        }
        const allCbs = this.listeners.get('*') || []
        for (const cb of allCbs) {
          if (!isCurrent()) return
          cb(data)
        }
      } catch (e) {
        console.error('WS parse error:', e)
      }
    }

    socket.onclose = () => {
      if (!isCurrent()) return
      this.ws = null
      this.setConnected(false)
      if (!this.active || this.connectionId !== connectionId || this.ws !== null) return
      this.reconnectTimer = setTimeout(() => {
        if (!this.active || this.connectionId !== connectionId) return
        this.reconnectTimer = null
        this.createConnection()
      }, 3000)
    }

    socket.onerror = () => {
      if (isCurrent()) socket.close()
    }
  }

  disconnect() {
    this.active = false
    this.connectionId++
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.close()
    }
    this.ws = null
    this.url = ''
    this.pending = []
    this.sendQueue = []
    this.hasConnectedBefore = false
    this.setConnected(false)
  }

  send(data: any) {
    if (!this.active) return
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    } else {
      this.sendQueue.push(data)
    }
  }

  on(type: string, callback: WSCallback) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, [])
    }
    this.listeners.get(type)!.push(callback)
    const pendingMsgs = this.pending.filter(p => p.type === type)
    if (pendingMsgs.length > 0) {
      this.pending = this.pending.filter(p => p.type !== type)
      const connectionId = this.connectionId
      for (const message of pendingMsgs) {
        if (!this.active || this.connectionId !== connectionId) return
        callback(message.data)
      }
    }
  }

  off(type: string, callback: WSCallback) {
    const cbs = this.listeners.get(type)
    if (cbs) {
      this.listeners.set(type, cbs.filter(cb => cb !== callback))
    }
  }

  onReconnect(callback: () => void) {
    this.reconnectCallbacks.push(callback)
  }

  offReconnect(callback: () => void) {
    this.reconnectCallbacks = this.reconnectCallbacks.filter(cb => cb !== callback)
  }
}

export const ws = new WSClient()
