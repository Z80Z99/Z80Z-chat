import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { api } from '../utils/api'
import { useAuthStore } from './auth'
import type { Server, Channel, Category, Member, Role, Invite, Permissions } from '../types'

export const useServerStore = defineStore('server', () => {
  const auth = useAuthStore()
  const servers = ref<Server[]>([])
  const currentServer = ref<Server | null>(null)
  const channels = ref<Channel[]>([])
  const categories = ref<Category[]>([])
  const members = ref<Member[]>([])
  const roles = ref<Role[]>([])
  const invites = ref<Invite[]>([])
  const currentChannel = ref<Channel | null>(null)
  let generation = 0, listVersion = 0, detailVersion = 0, channelEventVersion = 0, memberVersion = 0
  const removedServers = new Set<string>()
  const channelEvents = new Map<string, { version: number; serverId: string; channelId: string; channel?: Channel }>()
  const session = () => ({ generation, userId: auth.user?.id, token: localStorage.getItem('token') })
  const validSession = (value: ReturnType<typeof session>) => Boolean(value.userId && value.generation === generation &&
    value.userId === auth.user?.id && value.token === localStorage.getItem('token'))

  function clearSelection() {
    detailVersion++
    currentServer.value = null
    currentChannel.value = null
    channels.value = []; categories.value = []; members.value = []; roles.value = []; invites.value = []
  }
  function cancelServerNavigation() { detailVersion++ }
  watch(() => auth.user?.id, () => {
    generation++; listVersion++
    clearSelection()
    servers.value = []
    removedServers.clear(); channelEvents.clear()
  }, { flush: 'sync' })

  function hasPermission(key: keyof Permissions) {
    const server = currentServer.value, userId = auth.user?.id
    if (!server || !userId) return false
    if (server.ownerId === userId) return true
    const member = members.value.find(value => value.userId === userId && value.serverId === server.id)
    if (!member) return false
    return roles.value.some(role => role.serverId === server.id && (role.isDefault || member.roles.includes(role.id)) && role.permissions?.[key] === true)
  }
  const canManageServer = computed(() => hasPermission('manageServer'))
  const canPublishAnnouncements = computed(() => hasPermission('manageMessages'))
  function normalizeServer(server: Server): Server {
    return { ...server, banner: server.banner || '', profileRevision: server.profileRevision || 0,
      welcome: { title: '', message: '', rules: '', recommendedChannelIds: [], ...server.welcome } }
  }
  function newestServer(server: Server): Server {
    const known = currentServer.value?.id === server.id ? currentServer.value : servers.value.find(value => value.id === server.id)
    return known && (known.profileRevision || 0) > (server.profileRevision || 0) ? known : normalizeServer(server)
  }
  function handleServerUpdated(data: { serverId: string; server: Server }) {
    if (!auth.user || !data.server || data.server.id !== data.serverId || removedServers.has(data.serverId)) return
    const index = servers.value.findIndex(server => server.id === data.serverId)
    if (index < 0 && currentServer.value?.id !== data.serverId) return
    const updated = newestServer(data.server)
    if (index >= 0) servers.value[index] = updated
    if (currentServer.value?.id === data.serverId) currentServer.value = updated
  }
  function applyChannelEvent(data: { serverId: string; channelId?: string; channel?: Channel }) {
    if (currentServer.value?.id !== data.serverId) return
    const id = data.channel?.id || data.channelId
    if (!id || (data.channel && data.channel.serverId !== data.serverId)) return
    const index = channels.value.findIndex(channel => channel.id === id)
    if (!data.channel) {
      channels.value = channels.value.filter(channel => channel.id !== id)
      if (currentChannel.value?.id === id) currentChannel.value = null
      return
    }
    const existing = channels.value[index]
    if (existing && (existing.revision || 0) > (data.channel.revision || 0)) return
    if (index < 0) channels.value.push(data.channel)
    else channels.value[index] = data.channel
    if (currentChannel.value?.id === id) currentChannel.value = data.channel
  }
  function handleChannelEvent(data: { serverId: string; channelId?: string; channel?: Channel }) {
    const id = data.channel?.id || data.channelId
    if (!auth.user || !id || removedServers.has(data.serverId) || (data.channel && data.channel.serverId !== data.serverId)) return
    if (currentServer.value?.id !== data.serverId && !servers.value.some(server => server.id === data.serverId)) return
    const previous = channelEvents.get(id)
    if (data.channel && previous && (!previous.channel || (previous.channel.revision || 0) > (data.channel.revision || 0))) return
    channelEvents.set(id, { ...data, channelId: id, version: ++channelEventVersion })
    applyChannelEvent(data)
  }

  const sortedCategories = computed(() =>
    [...categories.value].sort((a, b) => a.position - b.position)
  )

  function channelsByCategory(categoryId: string | null) {
    return channels.value
      .filter(c => c.categoryId === categoryId)
      .sort((a, b) => a.position - b.position)
  }

  async function fetchServers() {
    const owner = session(), version = ++listVersion, known = new Set(servers.value.map(server => server.id))
    const data = await api.getServers()
    if (!validSession(owner) || version !== listVersion) return
    const incoming = data.servers.filter((server: Server) => !removedServers.has(server.id)).map(newestServer)
    const incomingIds = new Set(incoming.map((server: Server) => server.id))
    const added = servers.value.filter(server => !known.has(server.id) && !incomingIds.has(server.id))
    servers.value = [...incoming, ...added]
    if (currentServer.value && !servers.value.some(server => server.id === currentServer.value?.id)) clearSelection()
  }

  function captureServerSnapshot(serverId: string) {
    return { ...session(), serverId, detailVersion, eventVersion: channelEventVersion }
  }
  function commitServerSnapshot(data: any, context: ReturnType<typeof captureServerSnapshot>) {
    const id = context.serverId
    if (!validSession(context) || context.detailVersion !== detailVersion || removedServers.has(id) || data.server?.id !== id) return false
    const changed = currentServer.value?.id !== id
    memberVersion++
    currentServer.value = newestServer(data.server)
    channels.value = data.channels
    categories.value = data.categories
    members.value = data.members
    roles.value = data.roles
    if (changed) currentChannel.value = null
    else if (currentChannel.value) currentChannel.value = channels.value.find(channel => channel.id === currentChannel.value?.id) || null
    for (const event of channelEvents.values()) if (event.serverId === id && event.version > context.eventVersion) applyChannelEvent(event)
    return true
  }
  async function fetchServer(id: string) {
    detailVersion++
    const context = captureServerSnapshot(id)
    const data = await api.getServer(id)
    commitServerSnapshot(data, context)
    return data
  }

  async function createServer(name: string, description?: string) {
    const owner = session()
    const data = await api.createServer({ name, description })
    if (validSession(owner)) { removedServers.delete(data.server.id); servers.value.push(normalizeServer(data.server)) }
    return data
  }

  async function joinServer(code: string) {
    const owner = session()
    const data = await api.joinServer(code)
    if (!validSession(owner)) return data
    removedServers.delete(data.serverId)
    await fetchServers()
    return data
  }

  async function deleteServer(id: string) {
    const owner = session()
    await api.deleteServer(id)
    if (validSession(owner)) handleServerDeleted(id)
  }

  async function leaveServer(id: string) {
    const owner = session()
    await api.leaveServer(id)
    if (validSession(owner)) handleServerDeleted(id)
  }

  async function createChannel(serverId: string, data: any) {
    const owner = session()
    const res = await api.createChannel({ serverId, ...data })
    if (validSession(owner)) handleChannelEvent({ serverId, channel: res.channel })
    return res
  }

  async function deleteChannel(id: string) {
    const owner = session(), serverId = currentServer.value?.id
    await api.deleteChannel(id)
    if (validSession(owner) && serverId) handleChannelEvent({ serverId, channelId: id })
  }

  async function updateChannel(id: string, data: any) {
    const owner = session()
    const res = await api.updateChannel(id, data)
    if (validSession(owner)) handleChannelEvent({ serverId: res.channel.serverId, channel: res.channel })
    return res
  }

  async function updateServerProfile(data: any, serverId = currentServer.value?.id) {
    if (!serverId) return
    const owner = session()
    const res = await api.updateServer(serverId, data)
    if (validSession(owner)) handleServerUpdated({ serverId, server: res.server })
    return res
  }

  async function createCategory(serverId: string, name: string) {
    const res = await api.createCategory({ serverId, name })
    categories.value.push(res.category)
    return res
  }

  async function updateCategory(id: string, name: string) {
    const res = await api.updateCategory(id, { name })
    const idx = categories.value.findIndex(c => c.id === id)
    if (idx !== -1) categories.value[idx] = res.category
    return res
  }

  async function deleteCategory(id: string) {
    await api.deleteCategory(id)
    categories.value = categories.value.filter(c => c.id !== id)
    channels.value = channels.value.map(c => c.categoryId === id ? { ...c, categoryId: null } : c)
  }

  async function createInvite(serverId: string, maxUses?: number, expiresInHours?: number) {
    const res = await api.createInvite({ serverId, maxUses, expiresInHours })
    invites.value.push(res.invite)
    return res
  }

  async function fetchInvites(serverId: string) {
    const data = await api.getInvites(serverId)
    invites.value = data.invites
  }

  async function refreshMembers(serverId: string) {
    const owner = session(), version = ++memberVersion
    try {
      const data = await api.getMembers(serverId)
      if (!validSession(owner) || version !== memberVersion || currentServer.value?.id !== serverId) return
      members.value = data.members
    } catch {}
  }

  function handleServerDeleted(id: string) {
    removedServers.add(id)
    for (const [key, event] of channelEvents) if (event.serverId === id) channelEvents.delete(key)
    servers.value = servers.value.filter(s => s.id !== id)
    if (currentServer.value?.id === id) clearSelection()
  }

  function setCurrentChannel(channel: Channel | null) {
    detailVersion++
    if (channel && channel.serverId !== currentServer.value?.id) return
    currentChannel.value = channel ? channels.value.find(value => value.id === channel.id && value.serverId === currentServer.value?.id) || null : null
  }

  function handleUserProfileUpdated(data: { userId: string; avatar?: string; nickname?: string }) {
    const m = members.value.find(m => m.userId === data.userId)
    if (!m?.user) return
    if (data.avatar !== undefined) m.user.avatar = data.avatar
    if (data.nickname !== undefined) m.user.nickname = data.nickname
  }

  return {
    servers, currentServer, channels, categories, members, roles, invites, currentChannel,
    sortedCategories, channelsByCategory,
    hasPermission, canManageServer, canPublishAnnouncements, handleServerUpdated, handleChannelEvent, clearSelection, cancelServerNavigation,
    captureServerSnapshot, commitServerSnapshot,
    fetchServers, fetchServer, createServer, joinServer, deleteServer, leaveServer, updateServerProfile,
    createChannel, deleteChannel, updateChannel, createInvite, fetchInvites, refreshMembers, handleServerDeleted,
    createCategory, updateCategory, deleteCategory, setCurrentChannel, handleUserProfileUpdated
  }
})
