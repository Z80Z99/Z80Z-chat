import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../utils/api'
import { useAuthStore } from './auth'
import type { ChannelReadState } from '../types'

export const useReadStateStore = defineStore('read-state', () => {
  const auth = useAuthStore()
  const states = ref<Record<string, ChannelReadState>>({})
  const serverErrors = ref<Record<string, string>>({})
  const readErrors = ref<Record<string, string>>({})
  const serverChannels = new Map<string, string[]>()
  const deniedServers = new Set<string>()
  const removedChannels = new Set<string>()
  const serverRequests = new Map<string, { version: number; promise: Promise<void> }>()
  const readRequests = new Map<string, { target: { id: string; sequence: number } | null; promise: Promise<void> }>()
  let generation = 0
  let requestVersion = 0

  watch(() => auth.user?.id, () => {
    generation++
    states.value = {}
    serverErrors.value = {}
    readErrors.value = {}
    serverChannels.clear()
    deniedServers.clear()
    removedChannels.clear()
    serverRequests.clear()
    readRequests.clear()
  }, { flush: 'sync' })

  function mergeState(state: ChannelReadState, serverId?: string) {
    if (!auth.user || !state || typeof state.channelId !== 'string' ||
      ![state.readSequence, state.latestSequence, state.unreadCount, state.revision].every(value => Number.isSafeInteger(value) && value >= 0)) return
    if ((serverId && deniedServers.has(serverId)) || removedChannels.has(state.channelId)) return
    const previous = states.value[state.channelId]
    if (previous && state.revision < previous.revision) return
    if (previous && state.readSequence < previous.readSequence) return
    states.value[state.channelId] = { ...state }
    if (serverId) {
      const ids = serverChannels.get(serverId) || []
      if (!ids.includes(state.channelId)) serverChannels.set(serverId, [...ids, state.channelId])
    }
  }

  async function loadServer(serverId: string) {
    if (!auth.user) return
    const existing = serverRequests.get(serverId)
    if (existing) return existing.promise
    const account = auth.user.id
    const currentGeneration = generation
    const version = ++requestVersion
    const knownChannels = new Set(serverChannels.get(serverId) || [])
    delete serverErrors.value[serverId]
    const promise = (async () => {
      try {
        const data = await api.getReadStates(serverId)
        if (generation !== currentGeneration || auth.user?.id !== account) return
        const nextIds = new Set<string>(data.states.map((state: ChannelReadState) => state.channelId))
        deniedServers.delete(serverId)
        const liveNewChannels = (serverChannels.get(serverId) || []).filter(id => !knownChannels.has(id))
        for (const id of knownChannels) {
          if (!nextIds.has(id)) {
            delete states.value[id]
            readRequests.delete(id)
            removedChannels.add(id)
          }
        }
        serverChannels.set(serverId, [...new Set([...nextIds, ...liveNewChannels])])
        for (const state of data.states) { removedChannels.delete(state.channelId); mergeState(state, serverId) }
      } catch (error: any) {
        if (generation !== currentGeneration || auth.user?.id !== account) return
        serverErrors.value[serverId] = error?.message || '未读状态加载失败'
        if ([401, 403, 404].includes(error?.status)) {
          deniedServers.add(serverId)
          for (const id of serverChannels.get(serverId) || []) { delete states.value[id]; readRequests.delete(id); removedChannels.add(id) }
          serverChannels.delete(serverId)
        }
        throw error
      } finally {
        if (serverRequests.get(serverId)?.version === version) serverRequests.delete(serverId)
      }
    })()
    serverRequests.set(serverId, { version, promise })
    return promise
  }

  function markRead(channelId: string, messageId: string, sequence: number): Promise<void> {
    const state = states.value[channelId]
    if (!auth.user || !state || !Number.isSafeInteger(sequence) || sequence <= state.readSequence) return Promise.resolve()
    const existing = readRequests.get(channelId)
    if (existing) {
      if (!existing.target || sequence > existing.target.sequence) existing.target = { id: messageId, sequence }
      return existing.promise
    }
    const account = auth.user.id
    const currentGeneration = generation
    const request = { target: { id: messageId, sequence } as { id: string; sequence: number } | null, promise: Promise.resolve() }
    readRequests.set(channelId, request)
    request.promise = (async () => {
      try {
        while (request.target && generation === currentGeneration && auth.user?.id === account && readRequests.get(channelId) === request) {
          const target = request.target
          request.target = null
          if (target.sequence <= (states.value[channelId]?.readSequence || 0)) continue
          const data = await api.markChannelRead(channelId, target.id)
          if (generation !== currentGeneration || auth.user?.id !== account || readRequests.get(channelId) !== request || !states.value[channelId]) return
          mergeState(data.state, data.serverId)
          delete readErrors.value[channelId]
        }
      } catch (error: any) {
        if (generation === currentGeneration && auth.user?.id === account && readRequests.get(channelId) === request && states.value[channelId]) {
          readErrors.value[channelId] = error?.message || '阅读状态暂未同步'
        }
      } finally {
        if (readRequests.get(channelId) === request) readRequests.delete(channelId)
      }
    })()
    return request.promise
  }

  return { states, serverErrors, readErrors, mergeState, loadServer, markRead }
})
