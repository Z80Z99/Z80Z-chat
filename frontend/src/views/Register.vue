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
const confirmPassword = ref('')
const error = ref('')
const loading = ref(false)

async function handleRegister() {
  error.value = ''
  if (!username.value || !password.value) {
    error.value = '请输入用户名和密码'
    return
  }
  if (password.value !== confirmPassword.value) {
    error.value = '两次密码不一致'
    return
  }
  if (password.value.length < 4) {
    error.value = '密码至少4个字符'
    return
  }
  loading.value = true
  try {
    await auth.register(username.value, password.value)
    router.push('/')
  } catch (e: any) {
    error.value = e.message || '注册失败'
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
        <h1 class="text-2xl font-bold text-white">创建账号</h1>
        <p class="text-discord-200 text-sm mt-1">注册 {{ site.siteName }}</p>
      </div>

      <form @submit.prevent="handleRegister" class="space-y-4">
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
        <div class="animate-fade-in-up" style="animation-delay: 180ms">
          <label class="text-xs font-bold text-discord-200 uppercase tracking-wider">确认密码</label>
          <div class="auth-input-wrap mt-1">
            <svg class="auth-input-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            <input v-model="confirmPassword" type="password" class="input-discord text-base w-full pl-10" placeholder="再次输入密码" />
          </div>
        </div>

        <p v-if="error" class="text-red text-sm animate-fade-in-up">{{ error }}</p>

        <button type="submit" :disabled="loading" class="btn-gradient w-full py-3 animate-fade-in-up" style="animation-delay: 240ms">
          {{ loading ? '注册中...' : '注册' }}
        </button>
      </form>

      <p class="text-discord-200 text-sm text-center mt-4 animate-fade-in-up" style="animation-delay: 300ms">
        已有账号？
        <router-link to="/login" class="text-blurple hover:underline">登录</router-link>
      </p>
    </div>
  </div>
</template>
