<script setup lang="ts">
import { computed, ref, shallowRef, watch, onBeforeUnmount } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useServerStore } from '../stores/server'
import { api } from '../utils/api'
import type { Server, Channel } from '../types'
import type { CommunityImageKind } from '../utils/community-image'
import { validateCommunityImage } from '../utils/community-image'
import CommunityImageCropper from './CommunityImageCropper.vue'
import Avatar from './Avatar.vue'

const props = defineProps<{ server: Server; channels: Channel[]; canManage: boolean }>()
const emit = defineEmits<{ 'cropper-active': [active: boolean] }>()
const authStore = useAuthStore()
const serverStore = useServerStore()
const name = ref('')
const description = ref('')
const welcomeTitle = ref('')
const welcomeMessage = ref('')
const welcomeRules = ref('')
const recommendedIds = ref<string[]>([])
const avatarRemoved = ref(false)
const bannerRemoved = ref(false)
const bannerFailed = ref(false)
const avatarFailed = ref(false)
const avatarElement = ref<InstanceType<typeof Avatar> | null>(null)
const bannerElement = ref<HTMLImageElement | null>(null)
const saving = ref(false)
const reloading = ref(false)
const needsReload = ref(false)
const baseRevision = ref(0)
const status = ref('')
const saveError = ref('')
const cropFile = shallowRef<File | null>(null)
const cropKind = ref<CommunityImageKind>('avatar')
type PendingImage = { file: File; preview: string; uploadedUrl: string | null }
const pendingAvatar = shallowRef<PendingImage | null>(null)
const pendingBanner = shallowRef<PendingImage | null>(null)
let generation = 0
let mounted = true
let cropContext: { serverId: string; userId: string | null; token: string | null; version: number } | null = null

const sessionKey = computed(() => `${props.server.id}:${authStore.user?.id || ''}:${generation}`)
const availableChannels = computed(() => props.channels.filter(channel => channel.serverId === props.server.id).sort((a, b) => a.position - b.position))
const avatarPreview = computed(() => pendingAvatar.value?.preview || (avatarRemoved.value ? '' : props.server.avatar))
const bannerPreview = computed(() => pendingBanner.value?.preview || (bannerRemoved.value ? '' : props.server.banner || ''))

function revokePending(kind: CommunityImageKind) {
  const target = kind === 'avatar' ? pendingAvatar : pendingBanner
  if (target.value) URL.revokeObjectURL(target.value.preview)
  target.value = null
}
function closeCropper() { cropFile.value = null; cropContext = null; emit('cropper-active', false) }
function applyServerDraft(server: Server) {
  ++generation; closeCropper(); revokePending('avatar'); revokePending('banner')
  name.value = server.name || ''; description.value = server.description || ''
  welcomeTitle.value = server.welcome?.title || ''; welcomeMessage.value = server.welcome?.message || ''; welcomeRules.value = server.welcome?.rules || ''
  recommendedIds.value = [...new Set(server.welcome?.recommendedChannelIds || [])].filter(id => availableChannels.value.some(channel => channel.id === id)).slice(0, 6)
  baseRevision.value = server.profileRevision || 0
  avatarRemoved.value = false; bannerRemoved.value = false; bannerFailed.value = false; avatarFailed.value = false
  saving.value = false; reloading.value = false; needsReload.value = false; status.value = ''; saveError.value = ''
}
function resetDraft() { applyServerDraft(props.server) }
watch([() => props.server.id, () => authStore.user?.id, () => props.canManage], resetDraft, { immediate: true })
watch(() => availableChannels.value.map(channel => channel.id).join(','), () => {
  recommendedIds.value = recommendedIds.value.filter(id => availableChannels.value.some(channel => channel.id === id))
})
watch(bannerPreview, () => { bannerFailed.value = false })
watch(avatarPreview, () => { avatarFailed.value = false })

function onAvatarError(event: Event) {
  const image = event.currentTarget as HTMLImageElement | null
  const root = avatarElement.value?.$el as HTMLElement | undefined
  if (!image || root?.getAttribute('data-community-id') !== props.server.id
    || root.querySelector('img') !== image || image.getAttribute('src') !== avatarPreview.value) return
  avatarFailed.value = true
}
function onBannerError(event: Event) {
  const image = event.currentTarget as HTMLImageElement | null
  if (!image || image !== bannerElement.value || image.getAttribute('data-community-id') !== props.server.id
    || image.getAttribute('src') !== bannerPreview.value) return
  bannerFailed.value = true
}

function captureContext() {
  return { serverId: props.server.id, userId: authStore.user?.id || null, token: localStorage.getItem('token'), version: generation }
}
function isCurrent(context: ReturnType<typeof captureContext>) {
  return mounted && props.canManage && context.version === generation && props.server.id === context.serverId
    && serverStore.currentServer?.id === context.serverId && authStore.user?.id === context.userId && localStorage.getItem('token') === context.token
}
function chooseImage(event: Event, kind: CommunityImageKind) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || saving.value || reloading.value || !props.canManage) return
  saveError.value = ''; status.value = ''
  try {
    validateCommunityImage(file, kind)
    closeCropper(); cropContext = captureContext(); cropKind.value = kind; cropFile.value = file
    emit('cropper-active', true)
  } catch (e: any) { saveError.value = e.message || '无法读取图片' }
}
function acceptCrop(file: File) {
  if (!cropContext || !isCurrent(cropContext) || !cropFile.value) { closeCropper(); return }
  const kind = cropKind.value
  revokePending(kind)
  const pending = { file, preview: URL.createObjectURL(file), uploadedUrl: null }
  if (kind === 'avatar') { pendingAvatar.value = pending; avatarRemoved.value = false }
  else { pendingBanner.value = pending; bannerRemoved.value = false }
  closeCropper(); status.value = '图片已预览，保存修改后生效'
}
function removeImage(kind: CommunityImageKind) {
  if (saving.value || reloading.value || !props.canManage) return
  revokePending(kind)
  if (kind === 'avatar') avatarRemoved.value = true
  else bannerRemoved.value = true
  status.value = '图片已移除，保存修改后生效'; saveError.value = ''
}
function toggleRecommended(id: string, checked: boolean) {
  if (saving.value || reloading.value || !props.canManage || !availableChannels.value.some(channel => channel.id === id)) return
  if (!checked) { recommendedIds.value = recommendedIds.value.filter(current => current !== id); return }
  if (!recommendedIds.value.includes(id) && recommendedIds.value.length < 6) recommendedIds.value.push(id)
}

async function saveProfile() {
  if (saving.value || reloading.value || !props.canManage) return
  if (!name.value.trim()) { saveError.value = '请填写社区名称'; return }
  const context = captureContext()
  if (!isCurrent(context)) return
  const avatar = pendingAvatar.value, banner = pendingBanner.value
  const data: Record<string, any> = {
    name: name.value.trim(), description: description.value.trim(), expectedRevision: baseRevision.value,
    welcome: { title: welcomeTitle.value.trim(), message: welcomeMessage.value.trim(), rules: welcomeRules.value.trim(),
      recommendedChannelIds: recommendedIds.value.filter(id => availableChannels.value.some(channel => channel.id === id)).slice(0, 6) }
  }
  if (avatarRemoved.value) data.avatar = 'default'
  if (bannerRemoved.value) data.banner = ''
  saving.value = true; saveError.value = ''; status.value = ''
  try {
    for (const [kind, pending] of [['avatar', avatar], ['banner', banner]] as const) {
      if (!pending) continue
      if (!pending.uploadedUrl) {
        const response = await api.uploadCommunityImage(context.serverId, kind, pending.file)
        if (!isCurrent(context)) return
        if (!response.url) throw new Error('图片上传失败，请重试')
        pending.uploadedUrl = response.url
      }
      data[kind] = pending.uploadedUrl
    }
    if (!isCurrent(context)) return
    const response = await serverStore.updateServerProfile(data, context.serverId)
    if (!isCurrent(context)) return
    revokePending('avatar'); revokePending('banner'); avatarRemoved.value = false; bannerRemoved.value = false
    baseRevision.value = response?.server?.profileRevision ?? serverStore.currentServer?.profileRevision ?? baseRevision.value
    needsReload.value = false
    status.value = '社区资料已保存'
  } catch (e: any) { if (isCurrent(context)) { saveError.value = e.message || '保存失败，请重试'; needsReload.value = e.status === 409 } }
  finally { if (mounted && context.version === generation) saving.value = false }
}

async function reloadProfile() {
  if (saving.value || reloading.value || !props.canManage) return
  const context = captureContext()
  if (!isCurrent(context)) return
  reloading.value = true; saveError.value = ''; status.value = ''
  try {
    const response = await api.getServer(context.serverId)
    if (!isCurrent(context)) return
    serverStore.handleServerUpdated({ serverId: context.serverId, server: response.server })
    applyServerDraft(serverStore.currentServer || response.server)
    status.value = '已重新加载社区资料'
  } catch (e: any) { if (isCurrent(context)) saveError.value = e.message || '重新加载失败，请重试' }
  finally { if (mounted && context.version === generation) reloading.value = false }
}

onBeforeUnmount(() => {
  mounted = false; ++generation; closeCropper(); revokePending('avatar'); revokePending('banner')
})
</script>

<template>
  <div class="community-profile-editor">
    <form @submit.prevent="saveProfile" class="community-profile-form">
      <div class="community-profile-banner community-banner" :class="{ 'community-banner-fallback': !bannerPreview || bannerFailed }">
        <img v-if="bannerPreview && !bannerFailed" :key="`${server.id}:${bannerPreview}`" ref="bannerElement" :src="bannerPreview" :data-community-id="server.id" alt="社区横幅预览" @error="onBannerError" />
        <span class="community-banner-caption">横幅 · 4:1</span>
      </div>
      <div class="community-profile-identity">
        <Avatar :key="server.id" ref="avatarElement" :data-community-id="server.id" :src="avatarFailed ? null : avatarPreview" :name="name || server.name" size="profile" bg="bg-blurple" @error="onAvatarError" />
        <div class="community-profile-copy"><strong>{{ name || server.name }}</strong><p class="community-muted">创建于 {{ server.createdAt?.slice(0, 10) }}</p></div>
      </div>
      <fieldset v-if="canManage" class="community-profile-fields" :disabled="saving || reloading">
        <legend class="sr-only">编辑社区资料</legend>
        <div class="community-image-actions">
          <div>
            <label class="community-file-button btn-ghost">选择头像<input type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择社区头像" @change="chooseImage($event, 'avatar')" /></label>
            <button v-if="avatarPreview" type="button" class="btn-ghost" @click="removeImage('avatar')">移除头像</button>
          </div>
          <div>
            <label class="community-file-button btn-ghost">选择横幅<input type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择社区横幅" @change="chooseImage($event, 'banner')" /></label>
            <button v-if="bannerPreview" type="button" class="btn-ghost" @click="removeImage('banner')">移除横幅</button>
          </div>
          <p class="community-muted">PNG、JPEG、WebP；头像 2 MB，横幅 5 MB，宽高均不超过 4096 像素。</p>
        </div>
        <label class="community-field"><span>社区名称</span><input v-model="name" class="input-discord" maxlength="50" required /></label>
        <label class="community-field"><span>社区描述</span><textarea v-model="description" class="input-discord" maxlength="1000" rows="3" placeholder="在社区列表和首页中显示的简介"></textarea></label>
        <div class="community-section-divider"><h4>欢迎页</h4><p class="community-muted">留空时显示社区名称、描述和默认频道。</p></div>
        <label class="community-field"><span>欢迎标题</span><input v-model="welcomeTitle" class="input-discord" maxlength="100" :placeholder="`欢迎来到 ${server.name}`" /></label>
        <label class="community-field"><span>社区介绍</span><textarea v-model="welcomeMessage" class="input-discord" maxlength="2000" rows="4" placeholder="介绍话题、活动或新成员加入后的第一步"></textarea></label>
        <label class="community-field"><span>社区规则</span><textarea v-model="welcomeRules" class="input-discord" maxlength="4000" rows="5" placeholder="一行一条规则，按输入的换行显示"></textarea></label>
        <fieldset class="community-recommended-fields">
          <legend>推荐频道 <span>{{ recommendedIds.length }}/6</span></legend>
          <p class="community-muted">未选择时推荐默认频道。语音频道只导航，不自动加入通话。</p>
          <div class="community-channel-checkboxes">
            <label v-for="channel in availableChannels" :key="channel.id" class="community-channel-checkbox">
              <input type="checkbox" :checked="recommendedIds.includes(channel.id)" :disabled="saving || (!recommendedIds.includes(channel.id) && recommendedIds.length >= 6)" @change="toggleRecommended(channel.id, ($event.target as HTMLInputElement).checked)" />
              <span>{{ channel.type === 'voice' ? '◖' : channel.type === 'announcement' ? '◎' : '#' }} {{ channel.name }}</span>
            </label>
          </div>
          <p v-if="!availableChannels.length" class="community-muted">暂无频道。</p>
        </fieldset>
        <footer class="community-form-actions">
          <button type="submit" class="btn-primary" :disabled="saving">{{ saving ? '保存中…' : '保存修改' }}</button>
          <button type="button" class="btn-ghost" :disabled="saving" @click="resetDraft">重置修改</button>
        </footer>
      </fieldset>
      <div v-else class="community-profile-readonly">
        <p class="community-preserve-text">{{ server.description || '暂无社区描述。' }}</p>
        <p class="community-muted">拥有管理社区权限的成员可以编辑资料。</p>
      </div>
      <p v-if="saveError" class="community-error" role="alert">{{ saveError }}</p>
      <button v-if="needsReload" type="button" class="btn-ghost community-reload-button" :disabled="saving || reloading" @click="reloadProfile">{{ reloading ? '重新加载中…' : '重新加载资料' }}</button>
      <p v-if="status" class="community-success" role="status">{{ status }}</p>
    </form>
    <Teleport to="body">
      <CommunityImageCropper v-if="cropFile" :file="cropFile" :kind="cropKind" :session-key="sessionKey" @close="closeCropper" @confirm="acceptCrop" />
    </Teleport>
  </div>
</template>
