<script setup lang="ts">
import { ref } from 'vue'
import { useServerStore } from '../stores/server'
import type { Channel } from '../types'

const props = defineProps<{ channel: Channel }>()
const emit = defineEmits<{ close: [] }>()

const serverStore = useServerStore()

const name = ref(props.channel.name)
const categoryId = ref<string | null>(props.channel.categoryId)
const loading = ref(false)
const error = ref('')

async function handleSave() {
  error.value = ''
  if (!name.value.trim()) {
    error.value = '频道名称不能为空'
    return
  }
  loading.value = true
  try {
    await serverStore.updateChannel(props.channel.id, {
      name: name.value,
      categoryId: categoryId.value
    })
    emit('close')
  } catch (e: any) {
    error.value = e.message || '保存失败'
  } finally {
    loading.value = false
  }
}

async function handleDelete() {
  if (!window.confirm(`确定删除频道 #${props.channel.name}？频道内的消息将一并删除`)) return
  loading.value = true
  try {
    await serverStore.deleteChannel(props.channel.id)
    emit('close')
  } catch (e: any) {
    error.value = e.message || '删除失败'
    loading.value = false
  }
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal-content max-w-md">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-white">频道设置</h2>
        <button @click="emit('close')" class="text-discord-200 hover:text-white">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div class="space-y-4">
        <div>
          <label class="text-xs font-bold text-discord-200 uppercase tracking-wider">频道名称</label>
          <div class="flex items-center gap-2 mt-1">
            <span class="text-discord-200">{{ channel.type === 'text' ? '#' : '🔊' }}</span>
            <input v-model="name" class="input-discord flex-1" />
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

        <div class="flex items-center justify-between pt-2 border-t border-discord-600">
          <button @click="handleDelete" :disabled="loading" class="btn-red">删除频道</button>
          <div class="flex gap-2">
            <button @click="emit('close')" class="btn-ghost">取消</button>
            <button @click="handleSave" :disabled="loading" class="btn-primary">
              {{ loading ? '保存中...' : '保存' }}
            </button>
          </div>
        </div>

        <p v-if="error" class="text-red text-sm">{{ error }}</p>
      </div>
    </div>
  </div>
</template>
