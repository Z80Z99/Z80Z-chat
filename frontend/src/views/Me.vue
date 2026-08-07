<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { usePresence } from '../stores/presence'
import { api } from '../utils/api'

const router = useRouter()
const auth = useAuthStore()
const { onlineUserIds } = usePresence()

const nickname = ref(auth.user?.nickname || '')
const loading = ref(false)
const profileMsg = ref('')
const profileMsgType = ref<'ok' | 'err'>('ok')

const showPwdModal = ref(false)
const oldPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const pwdLoading = ref(false)
const pwdMsg = ref('')

const copied = ref(false)
const stats = ref<{ servers: number; friends: number }>({ servers: 0, friends: 0 })

const registeredAt = computed(() => {
  const d = new Date(auth.user?.createdAt || Date.now())
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
})

const isOnline = computed(() => auth.user?.id ? onlineUserIds.value.has(auth.user.id) : false)

const profileMsgText = computed(() =>
  profileMsgType.value === 'ok' ? 'text-green' : 'text-red'
)

let profileMsgTimer: any = null
let pwdMsgTimer: any = null

function showProfileMsg(text: string, type: 'ok' | 'err') {
  profileMsg.value = text
  profileMsgType.value = type
  clearTimeout(profileMsgTimer)
  profileMsgTimer = setTimeout(() => { profileMsg.value = '' }, 3000)
}

onMounted(async () => {
  try {
    const [s, f] = await Promise.all([api.getServers(), api.getFriends()])
    stats.value.servers = s.servers?.length || 0
    stats.value.friends = (f.friends || []).filter((x: any) => x.status === 'accepted').length
  } catch {}
})

async function handleSave() {
  loading.value = true
  try {
    await auth.updateProfile({
      nickname: nickname.value.trim() || auth.user?.username
    })
    showProfileMsg('保存成功', 'ok')
  } catch (e: any) {
    showProfileMsg(e.message || '保存失败', 'err')
  } finally {
    loading.value = false
  }
}

function openPwdModal() {
  oldPassword.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  pwdMsg.value = ''
  showPwdModal.value = true
}

async function handleChangePassword() {
  if (!oldPassword.value || !newPassword.value || !confirmPassword.value) {
    pwdMsg.value = '请填写完整'
    return
  }
  if (newPassword.value.length < 4) {
    pwdMsg.value = '新密码至少4个字符'
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    pwdMsg.value = '两次输入的新密码不一致'
    return
  }
  pwdLoading.value = true
  pwdMsg.value = ''
  try {
    await api.changePassword(oldPassword.value, newPassword.value)
    showPwdModal.value = false
    showProfileMsg('密码修改成功', 'ok')
  } catch (e: any) {
    pwdMsg.value = e.message || '修改失败'
  } finally {
    pwdLoading.value = false
  }
}

async function copyUserId() {
  try {
    await navigator.clipboard.writeText(auth.user?.id || '')
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {}
}

async function handleLogout() {
  if (!window.confirm('确定要退出登录吗？')) return
  await auth.logout()
  router.push('/login')
}

async function handleAvatarUpload(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files?.length) return
  const file = input.files[0]
  try {
    const res = await api.uploadImage(file)
    if (res.url) {
      await auth.updateProfile({ avatar: res.url })
      showProfileMsg('头像已更新', 'ok')
    }
  } catch (e: any) {
    showProfileMsg(e.message || '上传失败', 'err')
  }
}
</script>

<template>
  <div class="h-full flex flex-col bg-discord-700">
    <div class="h-12 bg-discord-900 flex items-center px-3 sm:px-4 shadow-md">
      <button @click="router.push('/')" class="btn-ghost flex items-center gap-2 px-2">
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
        <span class="hidden sm:inline">返回</span>
      </button>
      <h1 class="text-white font-bold ml-2 sm:ml-4">个人设置</h1>
    </div>

    <div class="flex-1 overflow-y-auto p-4 sm:p-8">
      <div class="max-w-2xl mx-auto space-y-6">

        <!-- 账户信息 -->
        <div class="bg-discord-800 rounded-lg p-5 sm:p-6">
          <div class="flex flex-col sm:flex-row items-center gap-5">
            <div class="relative group flex-shrink-0">
              <div class="w-24 h-24 rounded-full bg-discord-600 flex items-center justify-center overflow-hidden ring-2 ring-discord-500">
                <img v-if="auth.user?.avatar && auth.user.avatar !== 'default'"
                     :src="auth.user.avatar" class="w-full h-full object-cover" />
                <span v-else class="text-3xl font-bold text-white">
                  {{ auth.user?.username?.charAt(0).toUpperCase() }}
                </span>
              </div>
              <label class="absolute inset-0 bg-black/50 rounded-full flex items-center justify-center
                          opacity-0 group-hover:opacity-100 cursor-pointer transition-opacity">
                <svg class="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <input type="file" accept="image/*" class="hidden" @change="handleAvatarUpload" />
              </label>
            </div>
            <div class="text-center sm:text-left min-w-0">
              <div class="flex items-center justify-center sm:justify-start gap-2">
                <h2 class="text-xl font-bold text-white truncate">{{ auth.user?.nickname || auth.user?.username }}</h2>
                <span class="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      :class="isOnline ? 'bg-green' : 'bg-discord-300'"></span>
              </div>
              <button @click="copyUserId"
                      class="mt-1 flex items-center gap-1 text-discord-200 text-sm hover:text-white transition-colors">
                <span class="font-mono">ID: {{ auth.user?.id.slice(0, 8) }}...</span>
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                <span class="text-xs" :class="copied ? 'text-green' : ''">{{ copied ? '已复制' : '' }}</span>
              </button>
              <p class="text-discord-200 text-sm">注册于 {{ registeredAt }}</p>
              <div class="flex gap-4 mt-3 justify-center sm:justify-start">
                <div class="text-center">
                  <p class="text-lg font-bold text-white">{{ stats.servers }}</p>
                  <p class="text-xs text-discord-200">服务器</p>
                </div>
                <div class="text-center">
                  <p class="text-lg font-bold text-white">{{ stats.friends }}</p>
                  <p class="text-xs text-discord-200">好友</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 个人资料 -->
        <div class="bg-discord-800 rounded-lg p-5 sm:p-6">
          <h3 class="text-xs font-bold text-discord-200 uppercase tracking-wider mb-4">个人资料</h3>
          <div>
            <div class="flex items-center justify-between">
              <label class="text-xs font-bold text-discord-200 uppercase tracking-wider">昵称</label>
              <span class="text-xs text-discord-300">{{ nickname.length }}/30</span>
            </div>
            <input v-model="nickname" class="input-discord w-full mt-1" maxlength="30" placeholder="昵称" />
          </div>
          <div class="flex items-center gap-3 mt-5">
            <button @click="handleSave" :disabled="loading" class="btn-primary">
              {{ loading ? '保存中...' : '保存修改' }}
            </button>
            <p v-if="profileMsg" :class="profileMsgText" class="text-sm">{{ profileMsg }}</p>
          </div>
        </div>

        <!-- 账号 -->
        <div class="bg-discord-800 rounded-lg p-5 sm:p-6">
          <h3 class="text-xs font-bold text-discord-200 uppercase tracking-wider mb-4">账号</h3>
          <div class="flex flex-wrap gap-3">
            <button @click="openPwdModal" class="btn-primary">修改密码</button>
            <button @click="handleLogout" class="btn-red">退出登录</button>
          </div>
        </div>

      </div>
    </div>

    <!-- 修改密码浮窗 -->
    <div v-if="showPwdModal" class="modal-overlay" @click.self="showPwdModal = false">
      <div class="modal-content max-w-md">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-xl font-bold text-white">修改密码</h2>
          <button @click="showPwdModal = false" class="text-discord-200 hover:text-white">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div class="space-y-4">
          <div>
            <label class="text-xs font-bold text-discord-200 uppercase tracking-wider">当前密码</label>
            <input v-model="oldPassword" type="password" class="input-discord w-full mt-1"
                   placeholder="输入当前密码" />
          </div>
          <div>
            <label class="text-xs font-bold text-discord-200 uppercase tracking-wider">新密码</label>
            <input v-model="newPassword" type="password" class="input-discord w-full mt-1"
                   placeholder="至少4个字符" />
          </div>
          <div>
            <label class="text-xs font-bold text-discord-200 uppercase tracking-wider">确认新密码</label>
            <input v-model="confirmPassword" type="password" class="input-discord w-full mt-1"
                   placeholder="再次输入新密码" />
          </div>
        </div>
        <p v-if="pwdMsg" class="text-red text-sm mt-3">{{ pwdMsg }}</p>
        <button @click="handleChangePassword" :disabled="pwdLoading" class="btn-primary w-full mt-5">
          {{ pwdLoading ? '修改中...' : '确认修改' }}
        </button>
      </div>
    </div>
  </div>
</template>
