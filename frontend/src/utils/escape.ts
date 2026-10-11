// HTML 转义与消息内容格式化（纯函数，可单测）
// 渲染顺序：先转义再高亮，保证用户可控内容永不作为 HTML 执行

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface MentionDisplayUser { id: string; username?: string; nickname?: string }

export function messageContentText(content: string, users: MentionDisplayUser[] = []): string {
  const names = new Map(users.map(user => [user.id, user.nickname || user.username || '成员']))
  return content.replace(/<@([a-zA-Z0-9_-]{1,128})>/g, (_, id) => `@${names.get(id) || '已离开的成员'}`)
}

export function formatMessageContent(content: string, users: MentionDisplayUser[] = [], mentionEveryone = false): string {
  const names = new Map(users.map(user => [user.id, user.nickname || user.username || '成员']))
  const parts: string[] = []
  const pattern = /<@([a-zA-Z0-9_-]{1,128})>/g
  const plain = (text: string) => {
    if (!mentionEveryone) return escapeHtml(text)
    return escapeHtml(text).replace(/(^|[\s([{，。！？；：、])@everyone(?=$|[\s)\]},.!?;:，。！？；：、])/g,
      '$1<span class="message-mention message-mention-everyone">@everyone</span>')
  }
  let position = 0
  for (const match of content.matchAll(pattern)) {
    parts.push(plain(content.slice(position, match.index)))
    const id = match[1]
    const name = names.get(id)
    parts.push(name ? `<button type="button" class="message-mention" data-mention-id="${escapeHtml(id)}">@${escapeHtml(name)}</button>`
      : '<span class="message-mention message-mention-unavailable">@已离开的成员</span>')
    position = match.index! + match[0].length
  }
  parts.push(plain(content.slice(position)))
  return parts.join('')
}
