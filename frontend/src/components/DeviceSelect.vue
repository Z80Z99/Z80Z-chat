<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import MarqueeText from './MarqueeText.vue'

interface DeviceOption {
  deviceId: string
  label: string
}

const props = defineProps<{ devices: DeviceOption[]; modelValue: string }>()
const emit = defineEmits<{ (e: 'change', value: string): void }>()

const open = ref(false)
const wrap = ref<HTMLElement | null>(null)

const currentLabel = computed(() =>
  props.devices.find(d => d.deviceId === props.modelValue)?.label || '默认设备'
)

function toggle() {
  open.value = !open.value
}

function select(id: string) {
  open.value = false
  if (id !== props.modelValue) emit('change', id)
}

function onDocClick(e: MouseEvent) {
  if (wrap.value && !wrap.value.contains(e.target as Node)) {
    open.value = false
  }
}

onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <div ref="wrap" class="relative w-full min-w-0">
    <button type="button" @click.stop="toggle"
            class="w-full min-w-0 flex items-center gap-1 bg-discord-900 border border-discord-600 rounded-lg pl-2 pr-1.5 py-1.5 text-xs text-discord-100 hover:border-discord-400 transition-colors cursor-pointer">
      <div class="flex-1 min-w-0">
        <MarqueeText :text="currentLabel" />
      </div>
      <svg class="w-3.5 h-3.5 flex-shrink-0 text-discord-300 transition-transform"
           :class="open ? 'rotate-180' : ''"
           fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
      </svg>
    </button>
    <div v-if="open"
         class="absolute left-0 right-0 top-full mt-1 z-30 bg-discord-900 border border-discord-600 rounded-lg shadow-xl max-h-44 overflow-y-auto">
      <button v-for="d in devices" :key="d.deviceId" type="button"
              class="w-full text-left px-3 py-2 text-xs hover:bg-discord-700 flex items-center justify-between gap-2 transition-colors cursor-pointer"
              :class="d.deviceId === modelValue ? 'text-white bg-discord-700/60' : 'text-discord-100'"
              @click.stop="select(d.deviceId)">
        <span class="truncate">{{ d.label }}</span>
        <svg v-if="d.deviceId === modelValue" class="w-3.5 h-3.5 flex-shrink-0 text-green" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
        </svg>
      </button>
    </div>
  </div>
</template>
