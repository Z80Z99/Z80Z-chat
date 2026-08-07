import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '../utils/api'
import { ws } from '../utils/ws'
import type { User } from '../types'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const loading = ref(false)

  const isLoggedIn = computed(() => !!user.value)

  async function fetchMe() {
    try {
      const data = await api.me()
      user.value = data.user
      return data.user
    } catch {
      user.value = null
      localStorage.removeItem('token')
      throw new Error('登录已过期')
    }
  }

  async function login(username: string, password: string) {
    const data = await api.login(username, password)
    localStorage.setItem('token', data.token)
    user.value = data.user
    ws.connect(data.token)
    return data
  }

  async function register(username: string, password: string) {
    const data = await api.register(username, password)
    localStorage.setItem('token', data.token)
    user.value = data.user
    ws.connect(data.token)
    return data
  }

  async function logout() {
    try {
      await api.logout()
    } catch {}
    localStorage.removeItem('token')
    user.value = null
    ws.disconnect()
  }

  async function updateProfile(data: any) {
    const res = await api.updateUser(data)
    user.value = res.user
    return res
  }

  return { user, loading, isLoggedIn, fetchMe, login, register, logout, updateProfile }
})
