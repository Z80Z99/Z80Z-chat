// Each authenticated account has a query budget; idle accounts expire and memory stays bounded.
export function createMessageSearchRateLimiter({ windowMs = 10000, maxQueries = 20, maxUsers = 5000, clock = Date.now } = {}) {
  const entries = new Map()
  return userId => {
    const time = clock()
    let entry = entries.get(userId)
    if (!entry || time - entry.startedAt >= windowMs || time < entry.startedAt) {
      entry = { startedAt: time, count: 0 }
    }
    entries.delete(userId)
    if (entries.size >= maxUsers) {
      for (const [id, state] of entries) if (time - state.startedAt >= windowMs) entries.delete(id)
      if (entries.size >= maxUsers) entries.delete(entries.keys().next().value)
    }
    entries.set(userId, entry)
    if (entry.count >= maxQueries) return { allowed: false, retryAfter: Math.max(1, Math.ceil((windowMs - (time - entry.startedAt)) / 1000)) }
    entry.count++
    return { allowed: true }
  }
}
