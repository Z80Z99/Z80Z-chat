interface PressPoint {
  pointerId: number
  pointerType: string
  isPrimary?: boolean
  clientX: number
  clientY: number
}

interface PressContext { messageId: string }
interface PressOptions {
  delay?: number
  movement?: number
  now?: () => number
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  clear?: (timer: ReturnType<typeof setTimeout>) => void
}

// Retain normal touch scrolling. Only a stationary primary touch becomes a message action.
export function createMessagePress<T extends PressContext>(onLongPress: (context: T) => boolean, options: PressOptions = {}) {
  const now = options.now || Date.now
  const schedule = options.schedule || setTimeout
  const clear = options.clear || clearTimeout
  let timer: ReturnType<typeof setTimeout> | null = null
  let active: { point: Pick<PressPoint, 'pointerId' | 'clientX' | 'clientY'>; context: T; fired: boolean } | null = null
  let blockedUntil = 0

  function cancel() {
    if (timer !== null) clear(timer)
    timer = null
    if (active?.fired) blockedUntil = now() + 900
    active = null
  }

  function begin(point: PressPoint, context: T) {
    cancel()
    if (point.pointerType !== 'touch' || point.isPrimary === false) return
    clearClickBlock()
    // Browser PointerEvent coordinates are prototype accessors, not enumerable own fields.
    const pending = { point: { pointerId: point.pointerId, clientX: point.clientX, clientY: point.clientY }, context, fired: false }
    active = pending
    timer = schedule(() => {
      timer = null
      if (active !== pending) return
      pending.fired = onLongPress(pending.context)
      if (pending.fired) {
        blockedUntil = Infinity
      }
    }, options.delay ?? 500)
  }

  function move(point: PressPoint) {
    if (!active) return
    if (point.pointerId !== active.point.pointerId || Math.hypot(point.clientX - active.point.clientX, point.clientY - active.point.clientY) > (options.movement ?? 10)) cancel()
  }

  function end(point?: Pick<PressPoint, 'pointerId'>) {
    if (!point || !active || point.pointerId === active.point.pointerId) cancel()
  }

  function suppressesClick(): boolean {
    return now() < blockedUntil
  }

  function blockClick() {
    if (active) active.fired = true
    blockedUntil = active ? Infinity : now() + 900
  }

  function clearClickBlock() { blockedUntil = 0 }

  function reset() {
    cancel()
    clearClickBlock()
  }

  return { begin, move, end, cancel, reset, suppressesClick, blockClick, clearClickBlock }
}
