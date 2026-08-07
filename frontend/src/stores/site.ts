import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useSiteStore = defineStore('site', () => {
  const siteName = ref('NodeChat')

  async function init() {
    try {
      const res = await fetch('/api/config')
      const cfg = await res.json()
      if (cfg.siteName && typeof cfg.siteName === 'string') {
        siteName.value = cfg.siteName
      }
    } catch {}
    document.title = `${siteName.value} · 社区聊天`
  }

  return { siteName, init }
})
