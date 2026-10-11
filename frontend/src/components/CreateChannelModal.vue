<script setup lang="ts">
import { ref } from 'vue'
import { useServerStore } from '../stores/server'

const emit = defineEmits<{ close: [] }>()
const serverStore = useServerStore()

const name = ref('')
const type = ref<'text' | 'voice' | 'announcement'>('text')
const categoryId = ref<string | null>(null)
const loading = ref(false)
const error = ref('')

async function handleCreate() {
  if (loading.value) return
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
    <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="create-channel-title">
      <h2 id="create-channel-title" class="text-xl font-bold text-white mb-1">创建频道</h2>
      <p class="text-discord-200 text-sm mb-4">在 {{ serverStore.currentServer?.name }} 中创建新频道</p>

      <form @submit.prevent="handleCreate" class="space-y-4">
        <div>
          <label class="text-xs font-bold text-discord-200 uppercase tracking-wider">频道类型</label>
          <div class="channel-type-options grid grid-cols-1 sm:grid-cols-3 gap-3 mt-1">
            <label class="flex-1 flex items-center gap-3 bg-discord-600 rounded-lg p-3 cursor-pointer
                          hover:bg-discord-500 transition-colors"
                   :class="{ 'ring-2 ring-blurple': type === 'text' }">
              <input type="radio" name="channel-type" v-model="type" value="text" class="sr-only" />
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
              <input type="radio" name="channel-type" v-model="type" value="voice" class="sr-only" />
              <svg class="w-6 h-6 text-discord-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
              <div>
                <p class="text-white text-sm font-medium">语音频道</p>
                <p class="text-discord-200 text-xs">语音聊天</p>
              </div>
            </label>
            <label class="flex-1 flex items-center gap-3 bg-discord-600 rounded-lg p-3 cursor-pointer hover:bg-discord-500 transition-colors"
                   :class="{ 'ring-2 ring-blurple': type === 'announcement' }">
              <input type="radio" name="channel-type" v-model="type" value="announcement" class="sr-only" />
              <svg class="w-6 h-6 text-discord-200 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m3 10 15-6v16L3 14v-4Zm4 5 1 5h3l-2-4M21 9v6" /></svg>
              <div><p class="text-white text-sm font-medium">公告频道</p><p class="text-discord-200 text-xs">管理成员发布，所有成员可读</p></div>
            </label>
          </div>
        </div>

        <div>
          <label for="create-channel-name" class="text-xs font-bold text-discord-200 uppercase tracking-wider">频道名称</label>
          <div class="flex items-center gap-2 mt-1">
            <span class="text-discord-200">{{ type === 'text' ? '#' : type === 'announcement' ? '公告' : '语音' }}</span>
            <input id="create-channel-name" v-model="name" class="input-discord flex-1 min-w-0" placeholder="new-channel" maxlength="50" aria-label="频道名称" />
          </div>
        </div>

        <div>
          <label for="create-channel-category" class="text-xs font-bold text-discord-200 uppercase tracking-wider">所属分组</label>
          <select id="create-channel-category" v-model="categoryId" class="input-discord w-full mt-1">
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
