<script setup lang="ts">
import { ref } from 'vue'
import { useServerStore } from '../stores/server'

const emit = defineEmits<{ close: [] }>()
const serverStore = useServerStore()

const name = ref('')
const type = ref<'text' | 'voice'>('text')
const categoryId = ref<string | null>(null)
const loading = ref(false)
const error = ref('')

async function handleCreate() {
  error.value = ''
  if (!name.value.trim()) {
    error.value = '请输入频道名称'
    return
  }
  loading.value = true
  try {
    await serverStore.createChannel(serverStore.currentServer!.id, {
      name: name.value,
      type: type.value,
      categoryId: categoryId.value
    })
    emit('close')
  } catch (e: any) {
    error.value = e.message || '创建失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal-content">
      <h2 class="text-xl font-bold text-white mb-1">创建频道</h2>
      <p class="text-discord-200 text-sm mb-4">在 {{ serverStore.currentServer?.name }} 中创建新频道</p>

      <form @submit.prevent="handleCreate" class="space-y-4">
        <div>
          <label class="text-xs font-bold text-discord-200 uppercase tracking-wider">频道类型</label>
          <div class="flex gap-3 mt-1">
            <label class="flex-1 flex items-center gap-3 bg-discord-600 rounded-lg p-3 cursor-pointer
                          hover:bg-discord-500 transition-colors"
                   :class="{ 'ring-2 ring-blurple': type === 'text' }">
              <input type="radio" v-model="type" value="text" class="hidden" />
              <svg class="w-6 h-6 text-discord-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
              </svg>
              <div>
                <p class="text-white text-sm font-medium">文字频道</p>
                <p class="text-discord-200 text-xs">发送消息、图片</p>
              </div>
            </label>
            <label class="flex-1 flex items-center gap-3 bg-discord-600 rounded-lg p-3 cursor-pointer
                          hover:bg-discord-500 transition-colors"
                   :class="{ 'ring-2 ring-blurple': type === 'voice' }">
              <input type="radio" v-model="type" value="voice" class="hidden" />
              <svg class="w-6 h-6 text-discord-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
              <div>
                <p class="text-white text-sm font-medium">语音频道</p>
                <p class="text-discord-200 text-xs">语音聊天</p>
              </div>
            </label>
          </div>
        </div>

        <div>
          <label class="text-xs font-bold text-discord-200 uppercase tracking-wider">频道名称</label>
          <div class="flex items-center gap-2 mt-1">
            <span class="text-discord-200">{{ type === 'text' ? '#' : '🔊' }}</span>
            <input v-model="name" class="input-discord flex-1" placeholder="new-channel" />
          </div>
        </div>

        <div>
          <label class="text-xs font-bold text-discord-200 uppercase tracking-wider">所属分组</label>
          <select v-model="categoryId" class="input-discord w-full mt-1">
            <option :value="null">无分组</option>
            <option v-for="cat in serverStore.sortedCategories" :key="cat.id" :value="cat.id">
              {{ cat.name }}
            </option>
          </select>
        </div>

        <p v-if="error" class="text-red text-sm">{{ error }}</p>

        <div class="flex justify-end gap-3 pt-2">
          <button type="button" @click="emit('close')" class="btn-ghost">取消</button>
          <button type="submit" :disabled="loading" class="btn-primary">
            {{ loading ? '创建中...' : '创建频道' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
