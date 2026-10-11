export interface ChatViewportState {
  isMobile: boolean
  keyboardOpen: boolean
  style: Record<string, string>
}

// VisualViewport covers keyboards that resize only the visible area, including page panning.
export function observeChatViewport(browser: Window, update: (state: ChatViewportState) => void) {
  const viewport = browser.visualViewport
  let normalHeight = browser.innerHeight
  let layoutWidth = browser.innerWidth
  let frame: number | null = null
  let stopped = false
  const isEditing = () => {
    const element = browser.document.activeElement as HTMLElement | null
    return !!element?.matches('textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="password"], input[type="url"], input[type="tel"], input[type="number"], [contenteditable="true"]') &&
      !element.hasAttribute('readonly') && !element.hasAttribute('disabled')
  }
  function measure() {
    frame = null
    if (stopped) return
    const mobile = browser.innerWidth < 768
    const naturalScale = !viewport || Math.abs(viewport.scale - 1) < 0.02
    const height = naturalScale && viewport && viewport.height > 0 ? viewport.height : browser.innerHeight
    const editing = isEditing()
    // A rotated or resized layout starts a new baseline; focus does not make browser chrome a keyboard.
    if (!editing || Math.abs(browser.innerWidth - layoutWidth) > 80) normalHeight = Math.max(browser.innerHeight, height)
    layoutWidth = browser.innerWidth
    update({
      isMobile: mobile,
      keyboardOpen: mobile && naturalScale && editing && Math.max(normalHeight, browser.innerHeight) - height > 120,
      style: mobile ? {
        '--chat-viewport-height': `${Math.round(height)}px`,
        '--chat-viewport-top': `${Math.round(naturalScale ? Math.max(0, viewport?.offsetTop || 0) : 0)}px`
      } : {}
    })
  }
  function queue() { if (!stopped && frame === null) frame = browser.requestAnimationFrame(measure) }
  browser.addEventListener('resize', queue)
  browser.addEventListener('orientationchange', queue)
  browser.document.addEventListener('focusin', queue)
  browser.document.addEventListener('focusout', queue)
  viewport?.addEventListener('resize', queue)
  viewport?.addEventListener('scroll', queue)
  measure()
  return () => {
    stopped = true
    if (frame !== null) browser.cancelAnimationFrame(frame)
    browser.removeEventListener('resize', queue)
    browser.removeEventListener('orientationchange', queue)
    browser.document.removeEventListener('focusin', queue)
    browser.document.removeEventListener('focusout', queue)
    viewport?.removeEventListener('resize', queue)
    viewport?.removeEventListener('scroll', queue)
  }
}
