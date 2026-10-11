<script setup lang="ts">
interface DeviceOption { deviceId: string; label: string }
withDefaults(defineProps<{ devices: DeviceOption[]; modelValue: string; label?: string; disabled?: boolean }>(), { label: '音频设备', disabled: false })
const emit = defineEmits<{ (e: 'change', value: string): void }>()
</script>

<template>
  <select :value="modelValue" :aria-label="label" :disabled="disabled"
          class="voice-device-select w-full min-w-0 bg-discord-900 border border-discord-600 rounded-lg px-2 text-sm text-discord-100 disabled:opacity-50"
          @change="emit('change', ($event.target as HTMLSelectElement).value)">
    <option value="">系统默认设备</option>
    <option v-for="(device, index) in devices" :key="device.deviceId" :value="device.deviceId">
      {{ device.label || `设备 ${index + 1}` }}
    </option>
  </select>
</template>
