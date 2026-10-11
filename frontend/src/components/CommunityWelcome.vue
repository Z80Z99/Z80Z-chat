<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Server, Channel } from '../types'
import Avatar from './Avatar.vue'

const props = withDefaults(defineProps<{ server: Server; channels: Channel[]; canManage?: boolean }>(), { canManage: false })
const emit = defineEmits<{ 'select-channel': [channel: Channel]; 'open-settings': [] }>()
const bannerFailed = ref(false)
const avatarFailed = ref(false)
const avatarElement = ref<InstanceType<typeof Avatar> | null>(null)
const bannerElement = ref<HTMLImageElement | null>(null)
watch([() => props.server.id, () => props.server.banner], () => { bannerFailed.value = false })
watch([() => props.server.id, () => props.server.avatar], () => { avatarFailed.value = false })
const title = computed(() => props.server.welcome?.title?.trim() || `欢迎来到 ${props.server.name}`)
const message = computed(() => props.server.welcome?.message?.trim() || props.server.description?.trim() || '从下面的频道开始，认识成员，参与讨论。')
const recommendations = computed(() => {
  const channels = props.channels.filter(channel => channel.serverId === props.server.id)
  const ids = props.server.welcome?.recommendedChannelIds || []
  if (ids.length) return [...new Set(ids)].map(id => channels.find(channel => channel.id === id)).filter((channel): channel is Channel => !!channel).slice(0, 6)
  return [...channels].sort((a, b) => a.position - b.position).slice(0, 3)
})
function selectChannel(channel: Channel) {
  const current = props.channels.find(candidate => candidate.id === channel.id && candidate.serverId === props.server.id)
  if (current) emit('select-channel', current)
}
function onAvatarError(event: Event) {
  const image = event.currentTarget as HTMLImageElement | null
  const root = avatarElement.value?.$el as HTMLElement | undefined
  if (!image || root?.getAttribute('data-community-id') !== props.server.id
    || root.querySelector('img') !== image || image.getAttribute('src') !== props.server.avatar) return
  avatarFailed.value = true
}
function onBannerError(event: Event) {
  const image = event.currentTarget as HTMLImageElement | null
  if (!image || image !== bannerElement.value || image.getAttribute('data-community-id') !== props.server.id
    || image.getAttribute('src') !== props.server.banner) return
  bannerFailed.value = true
}
</script>

<template>
  <section class="community-welcome" aria-labelledby="community-welcome-title">
    <div class="community-banner" :class="{ 'community-banner-fallback': !server.banner || bannerFailed }">
      <img v-if="server.banner && !bannerFailed" :key="`${server.id}:${server.banner}`" ref="bannerElement" :src="server.banner" :data-community-id="server.id" alt="" @error="onBannerError" />
      <span class="community-banner-caption">社区首页</span>
    </div>
    <div class="community-welcome-body">
      <header class="community-welcome-heading">
        <Avatar :key="server.id" ref="avatarElement" :data-community-id="server.id" :src="avatarFailed ? null : server.avatar" :name="server.name" size="profile" bg="bg-blurple" @error="onAvatarError" />
        <div class="community-welcome-heading-copy">
          <p class="community-eyebrow">{{ server.name }}</p>
          <h1 id="community-welcome-title">{{ title }}</h1>
        </div>
        <button v-if="canManage" type="button" class="btn-ghost community-edit-button" @click="emit('open-settings')">编辑社区资料</button>
      </header>
      <div class="community-welcome-layout">
        <section class="community-welcome-card" aria-labelledby="community-introduction-title">
          <h2 id="community-introduction-title">社区介绍</h2>
          <p class="community-preserve-text">{{ message }}</p>
        </section>
        <section v-if="server.welcome?.rules?.trim()" class="community-welcome-card" aria-labelledby="community-rules-title">
          <h2 id="community-rules-title">社区规则</h2>
          <p class="community-preserve-text">{{ server.welcome.rules }}</p>
        </section>
        <section class="community-welcome-card community-recommendations" aria-labelledby="community-recommendations-title">
          <h2 id="community-recommendations-title">从这里开始</h2>
          <div v-if="recommendations.length" class="community-recommended-list">
            <button v-for="channel in recommendations" :key="channel.id" type="button" class="community-channel-button" @click="selectChannel(channel)">
              <span class="community-channel-symbol" aria-hidden="true">{{ channel.type === 'voice' ? '◖' : channel.type === 'announcement' ? '◎' : '#' }}</span>
              <span class="community-channel-copy"><strong>{{ channel.name }}</strong><span>{{ channel.type === 'voice' ? '语音频道 · 进入后可选择加入通话' : channel.type === 'announcement' ? '公告频道 · 查看社区动态' : '文字频道 · 开始交流' }}</span></span>
              <span class="community-channel-arrow" aria-hidden="true">→</span>
            </button>
          </div>
          <p v-else class="community-muted">暂无可推荐的频道。</p>
        </section>
      </div>
    </div>
  </section>
</template>
