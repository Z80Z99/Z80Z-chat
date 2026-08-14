import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '../utils/api'
import type { Server, Channel, Category, Member, Role, Invite } from '../types'

export const useServerStore = defineStore('server', () => {
  const servers = ref<Server[]>([])
  const currentServer = ref<Server | null>(null)
  const channels = ref<Channel[]>([])
  const categories = ref<Category[]>([])
  const members = ref<Member[]>([])
  const roles = ref<Role[]>([])
  const invites = ref<Invite[]>([])
  const currentChannel = ref<Channel | null>(null)

  const sortedCategories = computed(() =>
    categories.value.sort((a, b) => a.position - b.position)
  )

  function channelsByCategory(categoryId: string | null) {
    return channels.value
      .filter(c => c.categoryId === categoryId)
      .sort((a, b) => a.position - b.position)
  }

  async function fetchServers() {
    const data = await api.getServers()
    servers.value = data.servers
  }

  async function fetchServer(id: string) {
    const data = await api.getServer(id)
    currentServer.value = data.server
    channels.value = data.channels
    categories.value = data.categories
    members.value = data.members
    roles.value = data.roles
    return data
  }

  async function createServer(name: string, description?: string) {
    const data = await api.createServer({ name, description })
    servers.value.push(data.server)
    return data
  }

  async function joinServer(code: string) {
    const data = await api.joinServer(code)
    await fetchServers()
    return data
  }

  async function deleteServer(id: string) {
    await api.deleteServer(id)
    servers.value = servers.value.filter(s => s.id !== id)
    if (currentServer.value?.id === id) {
      currentServer.value = null
      channels.value = []
      categories.value = []
      members.value = []
      roles.value = []
      currentChannel.value = null
    }
  }

  async function leaveServer(id: string) {
    await api.leaveServer(id)
    servers.value = servers.value.filter(s => s.id !== id)
    if (currentServer.value?.id === id) {
      currentServer.value = null
      channels.value = []
      categories.value = []
      members.value = []
      roles.value = []
      currentChannel.value = null
    }
  }

  async function createChannel(serverId: string, data: any) {
    const res = await api.createChannel({ serverId, ...data })
    channels.value.push(res.channel)
    return res
  }

  async function deleteChannel(id: string) {
    await api.deleteChannel(id)
    channels.value = channels.value.filter(c => c.id !== id)
    if (currentChannel.value?.id === id) {
      currentChannel.value = null
    }
  }

  async function updateChannel(id: string, data: any) {
    const res = await api.updateChannel(id, data)
    const idx = channels.value.findIndex(c => c.id === id)
    if (idx !== -1) channels.value[idx] = res.channel
    return res
  }

  async function updateServerProfile(data: any) {
    if (!currentServer.value) return
    const res = await api.updateServer(currentServer.value.id, data)
    currentServer.value = { ...currentServer.value, ...res.server }
    const sIdx = servers.value.findIndex(s => s.id === res.server.id)
    if (sIdx !== -1) servers.value[sIdx] = res.server
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
    try {
      const data = await api.getMembers(serverId)
      members.value = data.members
    } catch {}
  }

  function handleServerDeleted(id: string) {
    servers.value = servers.value.filter(s => s.id !== id)
    if (currentServer.value?.id === id) {
      currentServer.value = null
      channels.value = []
      categories.value = []
      members.value = []
      roles.value = []
      currentChannel.value = null
    }
  }

  function setCurrentChannel(channel: Channel | null) {
    currentChannel.value = channel
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
    fetchServers, fetchServer, createServer, joinServer, deleteServer, leaveServer, updateServerProfile,
    createChannel, deleteChannel, updateChannel, createInvite, fetchInvites, refreshMembers, handleServerDeleted,
    createCategory, updateCategory, deleteCategory, setCurrentChannel, handleUserProfileUpdated
  }
})
