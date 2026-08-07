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

export function formatMessageContent(content: string): string {
  const esc = escapeHtml(content)
  return esc
    .replace(/@everyone/g, '<span class="text-yellow bg-yellow/20 px-1 rounded font-medium">@everyone</span>')
    .replace(/@(\w+)/g, '<span class="text-blurple font-medium">@$1</span>')
}
