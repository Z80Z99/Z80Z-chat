import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../utils/api'
import { ws } from '../utils/ws'
import { useAuthStore } from './auth'
import { useReadStateStore } from './read-state'
import type { MessageNotification, NotificationMode } from '../types'

export const useNotificationStore = defineStore('notifications', () => {
  const auth = useAuthStore()
  const readState = useReadStateStore()
  const notifications = ref<MessageNotification[]>([])
  const totalCount = ref(0)
  const unreadCount = computed(() => Math.max(totalCount.value, notifications.value.length))
  const loading = ref(false)
  const loadingMore = ref(false)
  const error = ref('')
  const hasMore = ref(false)
  const nextBefore = ref<number | null>(null)
  const inboxOpen = ref(false)
  const preferences = ref<Record<string, NotificationMode>>({})
  const preferenceErrors = ref<Record<string, string>>({})
  const preferenceLoading = ref<Record<string, boolean>>({})
  const pendingTarget = ref<MessageNotification | null>(null)
  const navigationError = ref('')
  const cursors = new Map<string, number>()
  const deleted = new Set<string>()
  const invalidated = new Map<string, number>()
  const liveChanges = new Map<string, { version: number; item: MessageNotification }>()
  const preferenceVersions = new Map<string, number>()
  const preferenceRequests = new Map<string, Promise<void>>()
  let account: string | null = null
  let token: string | null = null
  let generation = 0
  let requestVersion = 0
  let changeVersion = 0
  let countVersion = 0
  let subscribed = false
  let refreshQueued = false

  function isCurrent(accountId: string, sessionToken: string, epoch: number) {
    return generation === epoch && account === accountId && token === sessionToken &&
      auth.user?.id === accountId && localStorage.getItem('token') === sessionToken
  }
  function validItem(item: MessageNotification) {
    return item && typeof item.serverId === 'string' && typeof item.channelId === 'string' &&
      item.message && typeof item.message.id === 'string' && item.message.channelId === item.channelId &&
      Number.isSafeInteger(item.message.sequence) && ['mention', 'everyone', 'message'].includes(item.reason)
  }
  function eligible(item: MessageNotification, afterVersion?: number) {
    if (!validItem(item) || deleted.has(item.message.id) || (afterVersion !== undefined && (invalidated.get(item.message.id) || 0) > afterVersion) || item.message.userId === account) return false
    const cursor = Math.max(cursors.get(item.channelId) || 0, readState.states[item.channelId]?.readSequence || 0)
    const mode = preferences.value[item.channelId]
    return item.message.sequence > cursor && mode !== 'mute' && (mode !== 'mentions' || item.reason !== 'message')
  }
  function merge(base: MessageNotification[], afterVersion?: number) {
    const items = new Map<string, MessageNotification>()
    for (const item of base) if (eligible(item, afterVersion)) {
      const previous = items.get(item.message.id)
      if (!previous || (item.message.revision || 0) >= (previous.message.revision || 0)) items.set(item.message.id, item)
    }
    for (const { item, version } of liveChanges.values()) {
      const previous = items.get(item.message.id)
      if ((afterVersion === undefined || version > afterVersion || previous) && eligible(item) &&
        (!previous || (item.message.revision || 0) >= (previous.message.revision || 0))) items.set(item.message.id, item)
    }
    return [...items.values()].sort((a, b) => b.message.sequence - a.message.sequence || b.message.id.localeCompare(a.message.id))
  }
  function filterCurrent() {
    const previousCount = notifications.value.length
    notifications.value = notifications.value.filter(item => eligible(item))
    totalCount.value = Math.max(notifications.value.length, totalCount.value - previousCount + notifications.value.length)
  }
  function queueRefresh() {
    if (refreshQueued || !account || !token) return
    refreshQueued = true
    const epoch = generation
    queueMicrotask(() => {
      if (generation !== epoch) return
      refreshQueued = false
      void load().catch(() => {})
    })
  }
  async function reconcileCount() {
    if (!account || !token) return
    const epoch = generation, accountId = account, sessionToken = token
    const version = ++countVersion, changes = changeVersion, request = requestVersion
    try {
      const data = await api.getNotifications(1)
      if (isCurrent(accountId, sessionToken, epoch) && version === countVersion && changes === changeVersion && request === requestVersion && Number.isSafeInteger(data.totalCount)) {
        totalCount.value = Math.max(notifications.value.length, data.totalCount)
      }
    } catch {}
  }
  async function load(more = false) {
    if (!account || !token || !isCurrent(account, token, generation)) return
    if (more && (loading.value || loadingMore.value || !hasMore.value || nextBefore.value === null)) return
    const epoch = generation, accountId = account, sessionToken = token
    const version = ++requestVersion, changesAtStart = changeVersion
    const before = more ? nextBefore.value! : undefined
    if (more) loadingMore.value = true
    else { loading.value = true; loadingMore.value = false }
    error.value = ''
    try {
      const data = await api.getNotifications(50, before)
      if (!isCurrent(accountId, sessionToken, epoch) || version !== requestVersion) return
      const base = Array.isArray(data.notifications) ? data.notifications.filter(validItem) : []
      const filteredCount = base.filter((item: MessageNotification) => eligible(item, changesAtStart)).length
      notifications.value = merge(more ? [...notifications.value, ...base] : base, changesAtStart)
      const additions = [...liveChanges.values()].filter(({ item, version }) => version > changesAtStart && eligible(item) && !base.some((original: MessageNotification) => original.message.id === item.message.id)).length
      totalCount.value = Math.max(notifications.value.length, Math.max(0, Number.isSafeInteger(data.totalCount) ? data.totalCount : base.length) - base.length + filteredCount + additions)
      hasMore.value = data.hasMore === true && Number.isSafeInteger(data.nextBefore)
      nextBefore.value = hasMore.value ? data.nextBefore : null
      // The server total can already include an arrival absent from an older page.
      // Recheck just the total without replacing the reader's paged list.
      if (additions > 0) void reconcileCount()
    } catch (failure: any) {
      if (!isCurrent(accountId, sessionToken, epoch) || version !== requestVersion) return
      error.value = failure?.message || '通知加载失败，请重试'
      if ([401, 403].includes(failure?.status)) { notifications.value = []; totalCount.value = 0; hasMore.value = false; nextBefore.value = null }
      throw failure
    } finally {
      if (isCurrent(accountId, sessionToken, epoch) && version === requestVersion) { loading.value = false; loadingMore.value = false }
    }
  }
  function handleNotification(data: any) {
    if (!account || !token || !isCurrent(account, token, generation)) return
    const item = data.notification || data
    if (!validItem(item) || deleted.has(item.message.id)) return
    invalidated.delete(item.message.id)
    const previous = notifications.value.find(value => value.message.id === item.message.id) || liveChanges.get(item.message.id)?.item
    if (previous && (item.message.revision || 0) < (previous.message.revision || 0)) return
    liveChanges.set(item.message.id, { version: ++changeVersion, item })
    if (!eligible(item)) { filterCurrent(); return }
    const exists = notifications.value.some(value => value.message.id === item.message.id)
    notifications.value = merge([...notifications.value, item])
    if (!exists && !previous) totalCount.value++
  }
  function invalidate(data: any, permanent = false) {
    if (!account || !token || !isCurrent(account, token, generation) || typeof data.messageId !== 'string') return
    const version = ++changeVersion
    if (permanent) deleted.add(data.messageId)
    else invalidated.set(data.messageId, version)
    liveChanges.delete(data.messageId)
    const present = notifications.value.some(item => item.message.id === data.messageId)
    notifications.value = notifications.value.filter(item => item.message.id !== data.messageId)
    if (present) totalCount.value = Math.max(notifications.value.length, totalCount.value - 1)
    if (permanent && pendingTarget.value?.message.id === data.messageId) {
      pendingTarget.value = null
      navigationError.value = '这条消息已被删除'
      inboxOpen.value = true
    }
    queueRefresh()
  }
  function handleInvalidated(data: any) { invalidate(data) }
  function handleDeleted(data: any) { invalidate(data, true) }
  function handleRead(data: any) {
    if (!account || !token || !isCurrent(account, token, generation)) return
    const state = data.state
    if (!state || typeof state.channelId !== 'string' || !Number.isSafeInteger(state.readSequence) || state.readSequence < 0) return
    // New arrivals also broadcast read-state. Only an advancing cursor changes the inbox.
    if (state.readSequence <= (cursors.get(state.channelId) || 0)) return
    changeVersion++
    cursors.set(state.channelId, Math.max(cursors.get(state.channelId) || 0, state.readSequence))
    filterCurrent()
    queueRefresh()
  }
  function handlePreference(data: any) {
    if (!account || !token || !isCurrent(account, token, generation) || typeof data.channelId !== 'string' || !['all', 'mentions', 'mute'].includes(data.mode)) return
    changeVersion++
    preferences.value[data.channelId] = data.mode
    preferenceVersions.set(data.channelId, (preferenceVersions.get(data.channelId) || 0) + 1)
    filterCurrent()
    queueRefresh()
  }
  function reconnect() {
    if (!account) return
    const knownChannels = Object.keys(preferences.value)
    for (const channelId of new Set([...knownChannels, ...preferenceVersions.keys()])) preferenceVersions.set(channelId, (preferenceVersions.get(channelId) || 0) + 1)
    preferences.value = {}; preferenceRequests.clear(); preferenceLoading.value = {}
    void load().catch(() => {})
    for (const channelId of knownChannels) void loadPreference(channelId)
  }
  function activate() {
    const nextAccount = auth.user?.id || null, nextToken = localStorage.getItem('token')
    if (!nextAccount || !nextToken) { deactivate(); return }
    if (nextAccount === account && nextToken === token && subscribed) return
    deactivate()
    account = nextAccount; token = nextToken; subscribed = true
    ws.on('mention-notification', handleNotification)
    ws.on('mention-invalidated', handleInvalidated)
    ws.on('message-deleted', handleDeleted)
    ws.on('read-state', handleRead)
    ws.on('notification-preference', handlePreference)
    ws.onReconnect(reconnect)
    void load().catch(() => {})
  }
  function deactivate() {
    generation++; requestVersion++; refreshQueued = false
    if (subscribed) {
      ws.off('mention-notification', handleNotification); ws.off('mention-invalidated', handleInvalidated)
      ws.off('message-deleted', handleDeleted); ws.off('read-state', handleRead)
      ws.off('notification-preference', handlePreference); ws.offReconnect(reconnect)
    }
    subscribed = false; account = null; token = null
    notifications.value = []; totalCount.value = 0; loading.value = false; loadingMore.value = false
    error.value = ''; hasMore.value = false; nextBefore.value = null; inboxOpen.value = false
    preferences.value = {}; preferenceErrors.value = {}; preferenceLoading.value = {}
    pendingTarget.value = null; navigationError.value = ''
    cursors.clear(); deleted.clear(); invalidated.clear(); liveChanges.clear(); preferenceVersions.clear(); preferenceRequests.clear()
  }
  function loadPreference(channelId: string) {
    if (!account || !token) return Promise.resolve()
    if (preferenceRequests.has(channelId)) return preferenceRequests.get(channelId)!
    const epoch = generation, accountId = account, sessionToken = token
    const version = preferenceVersions.get(channelId) || 0
    preferenceLoading.value[channelId] = true
    let request!: Promise<void>
    request = (async () => {
      try {
        const data = await api.getNotificationPreference(channelId)
        if (!isCurrent(accountId, sessionToken, epoch) || (preferenceVersions.get(channelId) || 0) !== version) return
        if (['all', 'mentions', 'mute'].includes(data.mode)) preferences.value[channelId] = data.mode
        delete preferenceErrors.value[channelId]
        filterCurrent()
      } catch (failure: any) {
        if (isCurrent(accountId, sessionToken, epoch) && (preferenceVersions.get(channelId) || 0) === version) preferenceErrors.value[channelId] = failure?.message || '提醒设置加载失败'
      } finally {
        if (isCurrent(accountId, sessionToken, epoch) && preferenceRequests.get(channelId) === request) {
          preferenceRequests.delete(channelId); preferenceLoading.value[channelId] = false
        }
      }
    })()
    preferenceRequests.set(channelId, request)
    return request
  }
  async function setPreference(channelId: string, mode: NotificationMode) {
    if (!account || !token || preferenceLoading.value[channelId]) return
    const epoch = generation, accountId = account, sessionToken = token
    const version = (preferenceVersions.get(channelId) || 0) + 1
    preferenceVersions.set(channelId, version)
    preferenceLoading.value[channelId] = true
    delete preferenceErrors.value[channelId]
    try {
      const data = await api.setNotificationPreference(channelId, mode)
      if (!isCurrent(accountId, sessionToken, epoch)) return
      // The matching WS echo may already have advanced this channel's version.
      if ((preferenceVersions.get(channelId) || 0) === version && ['all', 'mentions', 'mute'].includes(data.mode)) preferences.value[channelId] = data.mode
      filterCurrent()
      queueRefresh()
    } catch (failure: any) {
      if (isCurrent(accountId, sessionToken, epoch)) preferenceErrors.value[channelId] = failure?.message || '提醒设置保存失败'
    } finally { if (isCurrent(accountId, sessionToken, epoch)) preferenceLoading.value[channelId] = false }
  }
  function requestNavigation(item: MessageNotification) {
    if (!eligible(item)) { navigationError.value = '这条通知已失效'; return false }
    pendingTarget.value = item
    navigationError.value = ''
    inboxOpen.value = false
    return true
  }
  function finishNavigation(item: MessageNotification, failure = '') {
    if (pendingTarget.value !== item) return
    pendingTarget.value = null
    navigationError.value = failure
    if (failure) inboxOpen.value = true
  }
  return { notifications, unreadCount, loading, loadingMore, error, hasMore, nextBefore, inboxOpen,
    preferences, preferenceErrors, preferenceLoading, pendingTarget, navigationError,
    activate, deactivate, load, loadPreference, setPreference, requestNavigation, finishNavigation }
})
