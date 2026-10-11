import type { Message } from '../types'

export function sameMessageDay(first: string, second: string): boolean {
  const a = new Date(first)
  const b = new Date(second)
  return Number.isFinite(a.getTime()) && Number.isFinite(b.getTime()) &&
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

export function shouldGroupMessages(previous: Message | undefined, message: Message): boolean {
  if (!previous || previous.userId !== message.userId || previous.channelId !== message.channelId ||
      previous.replyTo || message.replyTo || !sameMessageDay(previous.createdAt, message.createdAt)) return false
  const gap = new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime()
  return gap >= 0 && gap < 5 * 60 * 1000
}

// Only additions after the old tail count as arriving messages, not older pages.
export function appendedMessageIds(previous: string[], current: string[]): string[] {
  if (!previous.length) return []
  const tailIndex = current.indexOf(previous[previous.length - 1])
  if (tailIndex === -1) return []
  const known = new Set(previous)
  return current.slice(tailIndex + 1).filter(id => !known.has(id))
}

export function isNearMessageBottom(scrollTop: number, clientHeight: number, scrollHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= 80
}
