<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useNotificationStore } from '../stores/notifications'
import { useServerStore } from '../stores/server'
import { messageContentText } from '../utils/escape'
import { isMessageChannel } from '../utils/channel-type'
import type { MessageNotification, NotificationMode } from '../types'

const notifications = useNotificationStore()
const server = useServerStore()
const router = useRouter()
const panelRef = ref<HTMLElement | null>(null)
const channelId = computed(() => isMessageChannel(server.currentChannel) ? server.currentChannel!.id : null)
const modes: { value: NotificationMode; label: string }[] = [
  { value: 'all', label: '所有消息' }, { value: 'mentions', label: '仅提及' }, { value: 'mute', label: '静音' }
]
let trigger: HTMLElement | null = null
let focusGeneration = 0
let disposed = false

function close() { notifications.inboxOpen = false }
function focusable() {
  return [...(panelRef.value?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], select:not([disabled]), [tabindex="0"]') || [])].filter(element => !element.hidden)
}
function handleKeydown(event: KeyboardEvent) {
  if (!notifications.inboxOpen) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
  if (event.key !== 'Tab') return
  const elements = focusable(), first = elements[0], last = elements[elements.length - 1]
  if (!first) { event.preventDefault(); panelRef.value?.focus(); return }
  if (!panelRef.value?.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
watch(() => notifications.inboxOpen, async open => {
  const version = ++focusGeneration
  if (open) {
    trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.addEventListener('keydown', handleKeydown, true)
    void notifications.load().catch(() => {})
    await nextTick()
    if (!disposed && version === focusGeneration && notifications.inboxOpen) (focusable()[0] || panelRef.value)?.focus()
  } else {
    document.removeEventListener('keydown', handleKeydown, true)
    const previous = trigger
    trigger = null
    await nextTick()
    if (!disposed && version === focusGeneration && previous?.isConnected) previous.focus()
  }
}, { immediate: true })
watch([() => notifications.inboxOpen, channelId], ([open, id]) => {
  if (open && typeof id === 'string') void notifications.loadPreference(id)
}, { immediate: true })
onUnmounted(() => { disposed = true; focusGeneration++; document.removeEventListener('keydown', handleKeydown, true) })

function channelName(item: MessageNotification) {
  const name = server.currentServer?.id === item.serverId ? server.channels.find(channel => channel.id === item.channelId)?.name : null
  return name || '文字频道'
}
function serverName(item: MessageNotification) { return server.servers.find(value => value.id === item.serverId)?.name || '社区' }
function author(item: MessageNotification) { return item.message.user?.nickname || item.message.user?.username || '成员' }
function summary(item: MessageNotification) {
  const content = item.message.content || item.message.fileName || (item.message.image ? '图片' : '附件')
  return messageContentText(content, item.message.mentionUsers || []).slice(0, 240)
}
function time(item: MessageNotification) {
  const date = new Date(item.message.createdAt)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
async function openNotification(item: MessageNotification) {
  if (!notifications.requestNavigation(item)) return
  try { await router.push('/') }
  catch { notifications.finishNavigation(item, '暂时无法打开消息，请重试') }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="notifications.inboxOpen" class="notification-overlay" @click.self="close">
      <section ref="panelRef" class="notification-panel" role="dialog" aria-modal="true" aria-labelledby="notification-title" aria-describedby="notification-description" tabindex="-1">
        <header class="notification-header">
          <h2 id="notification-title">通知 <span class="notification-total">{{ notifications.unreadCount }}</span></h2>
          <button type="button" class="notification-close" aria-label="关闭通知" @click="close">×</button>
        </header>
        <p id="notification-description" class="notification-description">点击通知定位原消息。提醒会在读到消息后消失。</p>
        <div v-if="channelId" class="notification-preferences">
          <label for="notification-mode">#{{ server.currentChannel?.name }} 的提醒</label>
          <select id="notification-mode" :value="notifications.preferences[channelId] || 'mentions'" :disabled="notifications.preferenceLoading[channelId]" @change="notifications.setPreference(channelId!, ($event.target as HTMLSelectElement).value as NotificationMode)">
            <option v-for="mode in modes" :key="mode.value" :value="mode.value">{{ mode.label }}</option>
          </select>
          <p v-if="notifications.preferenceErrors[channelId]" class="notification-error" role="status">{{ notifications.preferenceErrors[channelId] }} <button type="button" @click="notifications.loadPreference(channelId!)">重试</button></p>
        </div>
        <div v-if="notifications.navigationError" class="notification-error" role="status">{{ notifications.navigationError }}</div>
        <div v-if="notifications.error" class="notification-error" role="status">{{ notifications.error }} <button type="button" @click="notifications.load().catch(() => {})">重试</button></div>
        <div class="notification-list" :aria-busy="notifications.loading || notifications.loadingMore">
          <p v-if="notifications.loading && !notifications.notifications.length" class="notification-empty" role="status">正在加载通知…</p>
          <p v-else-if="!notifications.notifications.length && !notifications.error" class="notification-empty">没有未读提醒</p>
          <button v-for="item in notifications.notifications" :key="item.message.id" type="button" class="notification-item" @click="openNotification(item)">
            <span class="notification-location">{{ serverName(item) }} · #{{ channelName(item) }}</span>
            <span class="notification-author">{{ author(item) }} <span class="notification-reason">{{ item.reason === 'mention' ? '提到了你' : item.reason === 'everyone' ? '提到了所有人' : '发来消息' }}</span></span>
            <span class="notification-summary">{{ summary(item) }}</span>
            <time class="notification-time" :datetime="item.message.createdAt">{{ time(item) }}</time>
          </button>
          <button v-if="notifications.hasMore" type="button" class="notification-more" :disabled="notifications.loadingMore || notifications.loading" @click="notifications.load(true).catch(() => {})">{{ notifications.loadingMore ? '正在加载…' : '加载更早提醒' }}</button>
        </div>
      </section>
    </div>
  </Teleport>
</template>
