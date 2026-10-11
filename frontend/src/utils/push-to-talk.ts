export interface PushToTalkOptions {
  enabled: () => boolean
  code: () => string
  setPressed: (pressed: boolean) => void
}

const supportedKeys = /^(?:Space|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(?:Up|Down|Left|Right)|Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter|Equal|Comma)|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|IntlBackslash|IntlRo|IntlYen)$/

export function isPushToTalkKey(code: unknown): code is string {
  return typeof code === 'string' && supportedKeys.test(code)
}

export function pushToTalkKeyLabel(code: string): string {
  if (code === 'Space') return '空格'
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  const labels: Record<string, string> = { Enter: '回车', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backspace: '退格' }
  return labels[code] || code
}

export function isEditableTarget(value: unknown): boolean {
  const target = value as Element | null
  if (!target || typeof target !== 'object') return false
  if ((target as HTMLElement).isContentEditable) return true
  return typeof target.closest === 'function' && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [data-ptt-key-capture]'))
}

/** Keyboard PTT belongs to the foreground page and never takes a text-field shortcut. */
export function installPushToTalk(win: Window, doc: Document, options: PushToTalkOptions) {
  let heldCode: string | null = null
  let disposed = false
  function release() {
    heldCode = null
    options.setPressed(false)
  }
  function keydown(event: KeyboardEvent) {
    if (disposed || heldCode || !options.enabled() || doc.visibilityState === 'hidden' ||
      (typeof doc.hasFocus === 'function' && !doc.hasFocus()) || event.defaultPrevented ||
      event.repeat || event.isComposing || event.keyCode === 229 || event.key === 'Process' ||
      event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
    const code = options.code()
    if (event.code !== code || !isPushToTalkKey(code)) return
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target]
    if (path.some(isEditableTarget)) return
    event.preventDefault()
    heldCode = code
    options.setPressed(true)
  }
  function keyup(event: KeyboardEvent) {
    // Release even when IME, modifiers, or a newly focused editor would block keydown.
    if (heldCode && event.code === heldCode) release()
  }
  function visibility() { if (doc.visibilityState === 'hidden') release() }
  win.addEventListener('keydown', keydown)
  win.addEventListener('keyup', keyup)
  win.addEventListener('blur', release)
  doc.addEventListener('visibilitychange', visibility)
  return {
    release,
    dispose() {
      if (disposed) return
      disposed = true
      win.removeEventListener('keydown', keydown)
      win.removeEventListener('keyup', keyup)
      win.removeEventListener('blur', release)
      doc.removeEventListener('visibilitychange', visibility)
      release()
    }
  }
}
