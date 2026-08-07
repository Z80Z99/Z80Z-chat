<script setup lang="ts">
import { ref } from 'vue'
import { useServerStore } from '../stores/server'

const emit = defineEmits<{ close: [] }>()
const serverStore = useServerStore()

const name = ref('')
const description = ref('')
const loading = ref(false)
const error = ref('')

async function handleCreate() {
  error.value = ''
  if (!name.value.trim()) {
    error.value = '请输入服务器名称'
    return
  }
  loading.value = true
  try {
    const data = await serverStore.createServer(name.value, description.value)
    await serverStore.fetchServer(data.server.id)
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
      <h2 class="text-xl font-bold text-white mb-1">创建服务器</h2>
      <p class="text-discord-200 text-sm mb-4">给你的服务器取个名字吧</p>

      <form @submit.prevent="handleCreate" class="space-y-4">
        <div>
          <label class="text-xs font-bold text-discord-200 uppercase tracking-wider">服务器名称</label>
          <input v-model="name" class="input-discord w-full mt-1" maxlength="50" placeholder="输入名称" />
        </div>
        <div>
          <label class="text-xs font-bold text-discord-200 uppercase tracking-wider">简介（可选）</label>
          <textarea v-model="description" class="input-discord w-full mt-1 resize-none" rows="3" maxlength="200"
                    placeholder="简单介绍一下你的服务器"></textarea>
        </div>

        <p v-if="error" class="text-red text-sm">{{ error }}</p>

        <div class="flex justify-end gap-3 pt-2">
          <button type="button" @click="emit('close')" class="btn-ghost">取消</button>
          <button type="submit" :disabled="loading" class="btn-primary">
            {{ loading ? '创建中...' : '创建' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
