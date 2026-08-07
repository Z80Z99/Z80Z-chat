<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useSiteStore } from '../stores/site'

const router = useRouter()
const auth = useAuthStore()
const site = useSiteStore()

const username = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)

async function handleLogin() {
  error.value = ''
  if (!username.value || !password.value) {
    error.value = '请输入用户名和密码'
    return
  }
  loading.value = true
  try {
    await auth.login(username.value, password.value)
    router.push('/')
  } catch (e: any) {
    error.value = e.message || '登录失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="auth-bg h-full flex items-center justify-center bg-[#1e1f22] p-4">
    <div class="auth-card">
      <div class="text-center mb-6 animate-fade-in-up">
        <div class="w-16 h-16 bg-gradient-to-br from-blurple to-[#7b7ff2] rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blurple/30 ring-4 ring-blurple/20">
          <span class="text-white text-3xl font-bold">NC</span>
        </div>
        <h1 class="text-2xl font-bold text-white">欢迎回来</h1>
        <p class="text-discord-200 text-sm mt-1">登录到 {{ site.siteName }}</p>
      </div>

      <form @submit.prevent="handleLogin" class="space-y-4">
        <div class="animate-fade-in-up" style="animation-delay: 60ms">
          <label class="text-xs font-bold text-discord-200 uppercase tracking-wider">用户名</label>
          <div class="auth-input-wrap mt-1">
            <svg class="auth-input-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            <input v-model="username" type="text" class="input-discord text-base w-full pl-10" placeholder="输入用户名" />
          </div>
        </div>
        <div class="animate-fade-in-up" style="animation-delay: 120ms">
          <label class="text-xs font-bold text-discord-200 uppercase tracking-wider">密码</label>
          <div class="auth-input-wrap mt-1">
            <svg class="auth-input-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <input v-model="password" type="password" class="input-discord text-base w-full pl-10" placeholder="输入密码" />
          </div>
        </div>

        <p v-if="error" class="text-red text-sm animate-fade-in-up">{{ error }}</p>

        <button type="submit" :disabled="loading" class="btn-gradient w-full py-3 animate-fade-in-up" style="animation-delay: 180ms">
          {{ loading ? '登录中...' : '登录' }}
        </button>
      </form>

      <p class="text-discord-200 text-sm text-center mt-4 animate-fade-in-up" style="animation-delay: 240ms">
        没有账号？
        <router-link to="/register" class="text-blurple hover:underline">注册</router-link>
      </p>
    </div>
  </div>
</template>
