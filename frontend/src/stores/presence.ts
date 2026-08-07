import { ref } from 'vue'
import { ws } from '../utils/ws'

const onlineUserIds = ref(new Set<string>())

ws.on('online-users', (data: any) => {
  const s = new Set<string>()
  if (Array.isArray(data.users)) {
    data.users.forEach((u: any) => s.add(u.id))
  }
  onlineUserIds.value = s
})

export function usePresence() {
  return { onlineUserIds }
}
