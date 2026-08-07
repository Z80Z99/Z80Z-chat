<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

const props = defineProps<{ text: string }>()

const clip = ref<HTMLElement | null>(null)
const scrolling = ref(false)
let timer: any = null

const display = computed(() => (scrolling.value ? `${props.text}　${props.text}` : props.text))

function check() {
  if (!clip.value) return
  const t = clip.value.firstElementChild as HTMLElement | null
  if (!t) return
  const over = t.scrollWidth > clip.value.clientWidth + 4
  if (over !== scrolling.value) scrolling.value = over
}

onMounted(() => {
  check()
  timer = setInterval(check, 1500)
})

onUnmounted(() => {
  clearInterval(timer)
})
</script>

<template>
  <div ref="clip" class="min-w-0 overflow-hidden whitespace-nowrap">
    <span class="inline-block" :class="{ 'animate-marquee': scrolling }">{{ display }}</span>
  </div>
</template>

<style scoped>
@keyframes marquee {
  from { transform: translateX(0); }
  to { transform: translateX(-50%); }
}
.animate-marquee {
  display: inline-block;
  animation: marquee 8s linear infinite;
}
.animate-marquee:hover {
  animation-play-state: paused;
}
</style>
