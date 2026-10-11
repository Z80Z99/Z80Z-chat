<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ScreenShareVideo from './ScreenShareVideo.vue'
import type { ScreenPlaybackState } from '../utils/screen-playback'

interface ScreenStageEntry {
  userId: string
  stream: MediaStream
  ts: number
  name: string
  local?: boolean
}
const props = withDefaults(defineProps<{ entries: ScreenStageEntry[]; cinema?: boolean }>(), { cinema: false })
const emit = defineEmits<{
  (event: 'update:cinema', cinema: boolean): void
  (event: 'refresh', userId: string): void
  (event: 'playback', userId: string, state: ScreenPlaybackState, stream: MediaStream): void
}>()
const selectedUserId = ref('')
let userSelected = false
let requestedEmptyExit = false
const selectedEntry = computed(() => props.entries.find(entry => entry.userId === selectedUserId.value))
const visibleCount = computed(() => selectedUserId.value ? Number(Boolean(selectedEntry.value)) : props.entries.length)
const selectionTitle = computed(() => selectedEntry.value ? entryName(selectedEntry.value) : `全部画面 · ${props.entries.length}`)

function entryName(entry: ScreenStageEntry) {
  return entry.name || (entry.local ? '你的投屏' : '成员投屏')
}
function optionLabel(entry: ScreenStageEntry, index: number) {
  const name = entryName(entry)
  const duplicate = props.entries.filter(value => entryName(value) === name).length > 1
  return `${name}${entry.local ? '（你的预览）' : ''}${duplicate ? ` · 画面 ${index + 1}` : ''}`
}
function isVisible(userId: string) { return !selectedUserId.value || selectedUserId.value === userId }
function chooseScreen(userId: string) {
  if (userId && !props.entries.some(entry => entry.userId === userId)) return
  selectedUserId.value = userId
  userSelected = true
}
function changeCinema() { emit('update:cinema', props.entries.length > 0 && !props.cinema) }
function currentEntry(entry: ScreenStageEntry) {
  return props.entries.some(value => value.userId === entry.userId && value.ts === entry.ts && value.stream === entry.stream)
}
function forwardRefresh(entry: ScreenStageEntry) {
  if (!entry.local && isVisible(entry.userId) && currentEntry(entry)) emit('refresh', entry.userId)
}
function forwardPlayback(entry: ScreenStageEntry, state: ScreenPlaybackState) {
  if (currentEntry(entry)) emit('playback', entry.userId, state, entry.stream)
}

watch([() => props.entries.map(entry => entry.userId), () => props.cinema], () => {
  if (!props.cinema) requestedEmptyExit = false
  if (!props.entries.length) {
    selectedUserId.value = ''
    userSelected = false
    if (props.cinema && !requestedEmptyExit) { requestedEmptyExit = true; emit('update:cinema', false) }
    return
  }
  requestedEmptyExit = false
  if (selectedUserId.value && !props.entries.some(entry => entry.userId === selectedUserId.value)) {
    selectedUserId.value = props.cinema ? props.entries[0].userId : ''
    userSelected = false
  }
  if (props.cinema && !selectedUserId.value && !userSelected) selectedUserId.value = props.entries[0].userId
}, { immediate: true, flush: 'sync' })
</script>

<template>
  <section class="screen-share-stage" :class="{ 'screen-share-stage-cinema': cinema }" :aria-label="cinema ? '影院模式投屏' : '投屏画面'">
    <header class="screen-stage-header">
      <div class="screen-stage-heading">
        <h2>{{ cinema ? '影院模式' : '投屏画面' }}</h2>
        <p v-if="entries.length" :title="selectionTitle">{{ selectionTitle }}</p>
      </div>
      <div v-if="entries.length" class="screen-stage-actions">
        <label class="screen-stage-picker">
          <span>观看画面</span>
          <select :value="selectedUserId" aria-label="观看画面" @change="chooseScreen(($event.target as HTMLSelectElement).value)">
            <option value="">全部画面</option>
            <option v-for="(entry, index) in entries" :key="entry.userId" :value="entry.userId">{{ optionLabel(entry, index) }}</option>
          </select>
        </label>
        <button type="button" class="screen-stage-cinema-toggle" :aria-label="cinema ? '退出影院模式' : '进入影院模式'"
                :aria-pressed="cinema" @click="changeCinema">
          {{ cinema ? '返回语音频道' : '影院模式' }}
        </button>
      </div>
    </header>
    <p v-if="!entries.length" class="screen-stage-empty" role="status">暂时没有投屏画面。成员开始共享后会显示在这里。</p>
    <div v-else class="screen-stage-grid" :class="{ 'screen-stage-grid-single': visibleCount === 1 }">
      <article v-for="entry in entries" v-show="isVisible(entry.userId)" :key="`${entry.userId}-${entry.ts}`" class="screen-stage-card" :data-screen-stage-user="entry.userId">
        <h3 class="screen-stage-card-title" :title="entryName(entry)">
          {{ entryName(entry) }}<span v-if="entry.local"> · 你的预览</span>
        </h3>
        <ScreenShareVideo :user-id="entry.userId" :stream="entry.stream" :name="entryName(entry)" :local="!!entry.local" :active="isVisible(entry.userId)"
                          @refresh="forwardRefresh(entry)" @playback="forwardPlayback(entry, $event)" />
      </article>
    </div>
  </section>
</template>
