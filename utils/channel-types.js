export function isMessageChannel(channel) {
  return channel?.type === 'text' || channel?.type === 'announcement'
}
