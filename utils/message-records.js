import { messageMentionIds } from './mentions.js'

export const MESSAGE_REACTIONS = Object.freeze(['👍', '❤️', '😂', '🎉', '😮', '😢'])

export function normalizeReactions(reactions) {
  const usersByEmoji = new Map()
  if (Array.isArray(reactions)) for (const reaction of reactions) {
    if (!MESSAGE_REACTIONS.includes(reaction?.emoji) || !Array.isArray(reaction.userIds)) continue
    if (!usersByEmoji.has(reaction.emoji)) usersByEmoji.set(reaction.emoji, new Set())
    for (const userId of reaction.userIds) {
      if (typeof userId === 'string' && userId) usersByEmoji.get(reaction.emoji).add(userId)
    }
  }
  return MESSAGE_REACTIONS.flatMap(emoji => {
    const userIds = [...(usersByEmoji.get(emoji) || [])]
    return userIds.length ? [{ emoji, userIds }] : []
  })
}

function publicUser(user) {
  return user ? { id: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar } : null
}

// Empty defaults are response-only for legacy records; reading never rewrites the database.
export function messagesWithUsers(db, messages) {
  const userMap = db.findUsersMap(messages.flatMap(message => [message.userId, message.pin?.userId,
    ...messageMentionIds(message), ...normalizeReactions(message.reactions).flatMap(reaction => reaction.userIds)].filter(Boolean)))
  return messages.map(message => ({
    ...message,
    mentions: messageMentionIds(message),
    mentionEveryone: message.mentionEveryone === true,
    mentionUsers: messageMentionIds(message).map(userId => publicUser(userMap.get(userId))).filter(Boolean),
    revision: Number.isSafeInteger(message.revision) && message.revision >= 0 ? message.revision : 0,
    reactions: normalizeReactions(message.reactions).map(reaction => ({
      ...reaction, users: reaction.userIds.map(userId => publicUser(userMap.get(userId))).filter(Boolean)
    })),
    pin: message.pin && typeof message.pin.userId === 'string' && typeof message.pin.createdAt === 'string'
      ? { userId: message.pin.userId, createdAt: message.pin.createdAt, user: publicUser(userMap.get(message.pin.userId)) }
      : null,
    user: publicUser(userMap.get(message.userId))
  }))
}
