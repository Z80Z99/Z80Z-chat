export function isMessageChannel<T extends { type?: string }>(channel: T | null | undefined): channel is T & { type: 'text' | 'announcement' } {
  return channel?.type === 'text' || channel?.type === 'announcement'
}
