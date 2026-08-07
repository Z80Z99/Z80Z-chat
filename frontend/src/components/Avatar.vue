<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  src?: string | null
  name?: string
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'profile' | 'xl'
  bg?: string
  border?: string
  ring?: string
  textClass?: string
  status?: string
  title?: string
}>(), {
  src: null,
  name: '',
  size: 'sm',
  bg: 'bg-discord-500',
  border: '',
  ring: '',
  textClass: '',
  status: '',
  title: ''
})

const validSrc = computed(() => {
  const s = props.src
  return s && s !== 'default' ? s : null
})

const initial = computed(() => (props.name || '?').charAt(0).toUpperCase())

const sizeClass = computed(() => ({
  xs: 'w-5 h-5',
  sm: 'w-8 h-8',
  md: 'w-10 h-10',
  lg: 'w-12 h-12',
  profile: 'w-20 h-20',
  xl: 'w-24 h-24'
}[props.size]))
</script>

<template>
  <div class="relative flex-shrink-0" :title="title">
    <div class="rounded-full flex items-center justify-center overflow-hidden"
         :class="[sizeClass, bg, border, ring]">
      <img v-if="validSrc" :src="validSrc" class="w-full h-full object-cover" />
      <span v-else class="text-white font-bold" :class="textClass">{{ initial }}</span>
    </div>
    <div v-if="status" class="w-3 h-3 rounded-full absolute -bottom-0.5 -right-0.5 border-2"
         :class="status"></div>
  </div>
</template>
