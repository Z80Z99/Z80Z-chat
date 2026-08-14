type WSCallback = (data: any) => void

class WSClient {
  private ws: WebSocket | null = null
  private listeners: Map<string, WSCallback[]> = new Map()
  private reconnectTimer: any = null
  private url: string = ''
  private pending: { type: string; data: any }[] = []
  private sendQueue: any[] = []
  private hasConnectedBefore = false
  private reconnectCallbacks: (() => void)[] = []

  connect(token: string) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    this.url = `${protocol}//${window.location.host}/ws?token=${token}`
    this.createConnection()
  }

  private createConnection() {
    if (this.reconnectTimer) {
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

    this.ws = new WebSocket(this.url)

    this.ws.onopen = () => {
      if (this.hasConnectedBefore) {
        this.reconnectCallbacks.forEach(cb => cb())
      }
      this.hasConnectedBefore = true
      const queued = this.sendQueue
      this.sendQueue = []
      queued.forEach(d => this.send(d))
    }

    this.ws.onmessage = (event) => {
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
        cbs.forEach(cb => cb(data))
        const allCbs = this.listeners.get('*') || []
        allCbs.forEach(cb => cb(data))
      } catch (e) {
        console.error('WS parse error:', e)
      }
    }

    this.ws.onclose = () => {
      this.reconnectTimer = setTimeout(() => this.createConnection(), 3000)
    }

    this.ws.onerror = () => {
      this.ws?.close()
    }
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
  }

  send(data: any) {
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
      pendingMsgs.forEach(p => callback(p.data))
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
}

export const ws = new WSClient()
