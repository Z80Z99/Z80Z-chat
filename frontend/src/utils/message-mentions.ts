export interface MentionSpan { start: number; end: number; userId: string }
export interface MentionUser { id: string; username: string; nickname?: string }
export interface MentionQuery { start: number; end: number; query: string }
export interface MentionEditIntent { text: string; start: number; end: number; inputType: string }

export function normalizeMentionSpans(text: string, value: unknown): MentionSpan[] {
  if (!Array.isArray(value)) return []
  const spans: MentionSpan[] = []
  for (const item of value.slice(0, 200).sort((a, b) => (a?.start || 0) - (b?.start || 0))) {
    if (!item || !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end)
      || item.start < 0 || item.end <= item.start + 1 || item.end > text.length
      || typeof item.userId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(item.userId)
      || text[item.start] !== '@' || (spans.length && item.start < spans[spans.length - 1].end)) continue
    spans.push({ start: item.start, end: item.end, userId: item.userId })
  }
  return spans
}

// Preserve identities only outside the changed range. Editing a selected name turns it into ordinary text.
export function updateMentionSpans(previous: string, next: string, value: unknown, intent?: MentionEditIntent | null): MentionSpan[] {
  const spans = normalizeMentionSpans(previous, value)
  let exact: { start: number; end: number } | null = null
  if (intent?.text === previous && Number.isSafeInteger(intent.start) && Number.isSafeInteger(intent.end)
    && intent.start >= 0 && intent.end >= intent.start && intent.end <= previous.length
    && /^(insert|delete)/.test(intent.inputType)) {
    let start = intent.start
    let end = intent.end
    if (start === end && intent.inputType.startsWith('delete')) {
      const removed = previous.length - next.length
      if (removed >= 0 && intent.inputType.endsWith('Backward')) start -= removed
      else if (removed >= 0 && intent.inputType.endsWith('Forward')) end += removed
      else start = -1
    }
    const inserted = next.length - previous.length + end - start
    if (start >= 0 && end <= previous.length && inserted >= 0
      && previous.slice(0, start) === next.slice(0, start)
      && previous.slice(end) === next.slice(start + inserted)) exact = { start, end }
  }
  if (previous === next && !exact) return spans
  let prefix = 0
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix++
  let suffix = 0
  while (suffix < previous.length - prefix && suffix < next.length - prefix
    && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++
  if (exact) prefix = exact.start
  const previousEnd = exact ? exact.end : previous.length - suffix
  const delta = next.length - previous.length
  return normalizeMentionSpans(next, spans.flatMap(span => {
    // Undo, unsupported input events and programmatic replacements cannot disambiguate equal labels.
    // Drop those identities rather than accidentally ping another member with the same nickname.
    const label = previous.slice(span.start, span.end)
    if (!exact && (previous.indexOf(label) !== previous.lastIndexOf(label) || next.indexOf(label) !== next.lastIndexOf(label))) return []
    if (span.end <= prefix) return [span]
    if (span.start >= previousEnd) return [{ ...span, start: span.start + delta, end: span.end + delta }]
    return []
  }))
}

export function serializeMentionText(text: string, value: unknown = []) {
  const spans = normalizeMentionSpans(text, value)
  let cursor = 0
  let content = ''
  const mentions: string[] = []
  let mentionEveryone = false
  for (const span of spans) {
    content += text.slice(cursor, span.start)
    if (span.userId === 'everyone') { content += '@everyone'; mentionEveryone = true }
    else { content += `<@${span.userId}>`; if (!mentions.includes(span.userId)) mentions.push(span.userId) }
    cursor = span.end
  }
  content = (content + text.slice(cursor)).trim()
  // An explicit, standalone everyone token also goes through server permission validation.
  mentionEveryone ||= /(^|[\s([{，。！？；：、])@everyone(?=$|[\s)\]},.!?;:，。！？；：、])/u.test(content)
  return { content, mentions, mentionEveryone }
}

export function parseMentionText(content: string, users: MentionUser[] = []) {
  const mentionSpans: MentionSpan[] = []
  const byId = new Map(users.map(user => [user.id, user]))
  let text = ''
  let cursor = 0
  for (const match of content.matchAll(/<@([a-zA-Z0-9_-]{1,128})>/g)) {
    text += content.slice(cursor, match.index)
    const userId = match[1]
    const user = byId.get(userId)
    const name = userId === 'everyone' ? 'everyone' : user?.nickname || user?.username || '已离开的成员'
    const start = text.length
    text += `@${name}`
    mentionSpans.push({ start, end: text.length, userId })
    cursor = match.index! + match[0].length
  }
  text += content.slice(cursor)
  return { text, mentionSpans }
}

export function findMentionQuery(text: string, start: number, end = start, value: unknown = []): MentionQuery | null {
  if (start !== end || !Number.isSafeInteger(start) || start < 0 || start > text.length) return null
  if (normalizeMentionSpans(text, value).some(span => start > span.start && start <= span.end)) return null
  const prefix = text.slice(0, start)
  const match = prefix.match(/(?:^|[\s([{])@([^\s@<>]{0,80})$/u)
  if (!match) return null
  return { start: start - match[1].length - 1, end: start, query: match[1] }
}

export function mentionChoices(users: MentionUser[], query: string, allowEveryone: boolean) {
  const needle = query.toLocaleLowerCase()
  const filtered = users.filter(user => user.username.toLocaleLowerCase().includes(needle)
    || (user.nickname || '').toLocaleLowerCase().includes(needle))
  return [ ...(allowEveryone && 'everyone'.includes(needle) ? [{ id: 'everyone', username: 'everyone', nickname: '所有成员' }] : []), ...filtered ].slice(0, 8)
}
