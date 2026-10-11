<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useChatStore } from '../stores/chat'
import { useServerStore } from '../stores/server'
import { api } from '../utils/api'
import type { Message } from '../types'

const props = defineProps<{ message: Message; pickerOpen?: boolean }>()
const emit = defineEmits<{ 'close-picker': [] }>()
const authStore = useAuthStore()
const chatStore = useChatStore()
const serverStore = useServerStore()
const rootRef = ref<HTMLElement | null>(null)
const membersButtonRef = ref<HTMLButtonElement | null>(null)
const pending = ref(false)
const error = ref('')
const failedAction = ref<{ emoji: string; active: boolean } | null>(null)
const selectedEmoji = ref<string | null>(null)
let generation = 0
let disposed = false

const choices = [
  { emoji: '👍', label: '赞' }, { emoji: '❤️', label: '喜欢' },
  { emoji: '😂', label: '好笑' }, { emoji: '🎉', label: '庆祝' },
  { emoji: '😮', label: '惊讶' }, { emoji: '😢', label: '难过' }
]
const reactions = computed(() => (props.message.reactions || [])
  .filter(reaction => choices.some(choice => choice.emoji === reaction.emoji))
  .map(reaction => ({ ...reaction, userIds: [...new Set(reaction.userIds)] }))
  .filter(reaction => reaction.userIds.length > 0))
const canReact = computed(() => {
  const userId = authStore.user?.id
  const server = serverStore.currentServer
  const channel = serverStore.currentChannel
  if (!userId || !server || !channel || channel.serverId !== server.id || channel.id !== props.message.channelId ||
      chatStore.currentChannelId !== channel.id) return false
  const member = serverStore.members.find(item => item.userId === userId && item.serverId === server.id)
  if (!member || member.muted) return false
  if (server.ownerId === userId) return true
  const roles = serverStore.roles.filter(role => role.serverId === server.id && (role.isDefault || member.roles.includes(role.id)))
  return roles.some(role => role.permissions?.viewChannel) && roles.some(role => role.permissions?.sendMessage)
})
const selectedReaction = computed(() => reactions.value.find(reaction => reaction.emoji === selectedEmoji.value))
const participantNames = computed(() => (selectedReaction.value?.userIds || []).map(userId => {
  const member = serverStore.members.find(item => item.userId === userId)?.user
  const user = member || selectedReaction.value?.users?.find(item => item.id === userId)
  return { userId, name: user?.nickname || user?.username || '已离开的成员' }
}))
const membersId = computed(() => `reaction-members-${props.message.id}`)

function hasReacted(emoji: string) {
  return Boolean(authStore.user?.id && reactions.value.find(reaction => reaction.emoji === emoji)?.userIds.includes(authStore.user.id))
}
function reactionLabel(emoji: string) { return choices.find(choice => choice.emoji === emoji)?.label || '回应' }
function token() {
  try { return window.localStorage.getItem('token') } catch { return null }
}
function restoreMessageFocus() {
  rootRef.value?.closest('[data-message-id]')?.querySelector<HTMLButtonElement>('.message-menu-button')?.focus({ preventScroll: true })
}
function closePicker() {
  emit('close-picker')
  nextTick(() => { if (!disposed) restoreMessageFocus() })
}
function closeMembers() {
  selectedEmoji.value = null
  nextTick(() => { if (!disposed) membersButtonRef.value?.focus({ preventScroll: true }) })
}
function showMembers() {
  if (selectedEmoji.value) { closeMembers(); return }
  selectedEmoji.value = reactions.value[0]?.emoji || null
  nextTick(() => rootRef.value?.querySelector<HTMLButtonElement>('.message-reaction-members button')?.focus({ preventScroll: true }))
}
function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || (!props.pickerOpen && !selectedEmoji.value)) return
  event.preventDefault()
  event.stopPropagation()
  if (props.pickerOpen) closePicker()
  if (selectedEmoji.value) closeMembers()
}

async function setReaction(emoji: string, active: boolean) {
  if (pending.value || !canReact.value || !choices.some(choice => choice.emoji === emoji)) return
  const accountId = authStore.user?.id
  const sessionToken = token()
  const channelId = props.message.channelId
  const messageId = props.message.id
  const requestGeneration = ++generation
  const current = () => !disposed && generation === requestGeneration && authStore.user?.id === accountId && token() === sessionToken &&
    serverStore.currentChannel?.id === channelId && chatStore.currentChannelId === channelId &&
    props.message.id === messageId && props.message.channelId === channelId && chatStore.messages.some(message => message.id === messageId)
  pending.value = true
  error.value = ''
  failedAction.value = null
  try {
    const result = await api.setMessageReaction(messageId, emoji, active)
    if (!current()) return
    if (!result?.message || result.message.id !== messageId || result.message.channelId !== channelId) throw new Error('回应结果无效，请重试')
    chatStore.updateMessage(messageId, result.message)
    if (props.pickerOpen) closePicker()
  } catch (cause) {
    if (!current()) return
    const message = cause && typeof cause === 'object' && 'message' in cause ? cause.message : null
    error.value = typeof message === 'string' && message.trim() ? message : '回应失败，请重试'
    failedAction.value = { emoji, active }
  } finally {
    if (!disposed && generation === requestGeneration) pending.value = false
  }
}
function toggleReaction(emoji: string) { return setReaction(emoji, !hasReacted(emoji)) }
function retryReaction() {
  if (!failedAction.value) return
  return setReaction(failedAction.value.emoji, failedAction.value.active)
}

watch([() => authStore.user?.id, () => serverStore.currentChannel?.id, () => props.message.id, () => props.message.channelId], () => {
  generation++
  pending.value = false
  error.value = ''
  failedAction.value = null
  selectedEmoji.value = null
}, { flush: 'sync' })
watch(() => props.pickerOpen, open => {
  if (!open) return
  error.value = ''
  nextTick(() => {
    if (!disposed && props.pickerOpen) rootRef.value?.querySelector<HTMLButtonElement>('.message-reaction-picker button:not(:disabled)')?.focus({ preventScroll: true })
  })
})
watch([selectedEmoji, reactions], () => {
  if (selectedEmoji.value && !selectedReaction.value) closeMembers()
})
onUnmounted(() => { disposed = true; generation++ })
</script>

<template>
  <div v-if="reactions.length || pickerOpen || error" ref="rootRef" class="message-reactions" @keydown="handleKeydown">
    <div v-if="reactions.length" class="message-reaction-summary" aria-label="消息回应">
      <button v-for="reaction in reactions" :key="reaction.emoji" type="button" class="message-reaction-chip"
              :aria-pressed="hasReacted(reaction.emoji)" :disabled="pending || !canReact"
              :aria-label="`${reactionLabel(reaction.emoji)}，${reaction.userIds.length} 人回应${hasReacted(reaction.emoji) ? '，你已回应，点击取消' : '，点击回应'}`"
              @click="toggleReaction(reaction.emoji)">
        <span aria-hidden="true">{{ reaction.emoji }}</span><span>{{ reaction.userIds.length }}</span>
      </button>
      <button ref="membersButtonRef" type="button" class="message-reaction-members-toggle"
              :aria-expanded="Boolean(selectedEmoji)" :aria-controls="membersId" @click="showMembers">查看回应成员</button>
    </div>
    <div v-if="pickerOpen" class="message-reaction-picker" role="group" aria-label="选择回应" :aria-busy="pending">
      <button v-for="choice in choices" :key="choice.emoji" type="button" class="message-reaction-choice"
              :aria-label="choice.label" :aria-pressed="hasReacted(choice.emoji)" :disabled="pending || !canReact" @click="toggleReaction(choice.emoji)">
        <span aria-hidden="true">{{ choice.emoji }}</span>
      </button>
      <button type="button" class="message-reaction-cancel" @click="closePicker">取消</button>
      <p v-if="!canReact" class="message-reaction-note">当前无法回应此消息</p>
      <span v-else-if="pending" class="message-reaction-note" role="status">正在保存回应…</span>
    </div>
    <div v-if="selectedEmoji && selectedReaction" :id="membersId" class="message-reaction-members" role="region" aria-label="回应成员">
      <div class="message-reaction-member-tabs" role="group" aria-label="查看不同回应的成员">
        <button v-for="reaction in reactions" :key="reaction.emoji" type="button" :aria-pressed="selectedEmoji === reaction.emoji"
                :aria-label="`${reactionLabel(reaction.emoji)}，${reaction.userIds.length} 人`" @click="selectedEmoji = reaction.emoji">
          <span aria-hidden="true">{{ reaction.emoji }}</span><span>{{ reaction.userIds.length }}</span>
        </button>
        <button type="button" class="message-reaction-close" @click="closeMembers">关闭</button>
      </div>
      <p class="message-reaction-member-heading">{{ reactionLabel(selectedEmoji) }} · {{ participantNames.length }} 人</p>
      <ul class="message-reaction-member-names"><li v-for="participant in participantNames" :key="participant.userId">{{ participant.name }}</li></ul>
    </div>
    <div v-if="error" class="message-reaction-error" role="alert">
      <span>{{ error }}</span>
      <button v-if="failedAction" type="button" :disabled="pending || !canReact" @click="retryReaction">重试</button>
    </div>
  </div>
</template>
