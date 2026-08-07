<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useServerStore } from '../stores/server'
import { useAuthStore } from '../stores/auth'
import { api } from '../utils/api'
import type { Role, Member } from '../types'
import Avatar from './Avatar.vue'

const emit = defineEmits<{ close: [] }>()
const router = useRouter()
const serverStore = useServerStore()
const authStore = useAuthStore()

const activeTab = ref<'overview' | 'channels' | 'roles' | 'members'>('overview')
const roles = ref<Role[]>([])
const members = ref<Member[]>([])

const isOwner = computed(() => serverStore.currentServer?.ownerId === authStore.user?.id)

const tabs = computed(() => {
  const list: { key: 'overview' | 'channels' | 'roles' | 'members'; label: string; ownerOnly?: boolean }[] = [
    { key: 'overview', label: '概览' },
    { key: 'channels', label: '频道管理', ownerOnly: true },
    { key: 'roles', label: '角色' },
    { key: 'members', label: '成员' }
  ]
  return list.filter(t => !t.ownerOnly || isOwner.value)
})

// Overview editing
const serverName = ref(serverStore.currentServer?.name || '')
const serverDesc = ref(serverStore.currentServer?.description || '')
const saving = ref(false)
const saveMsg = ref('')

// Channel management
const newCatName = ref('')
const newChannelName = ref('')
const newChannelType = ref<'text' | 'voice'>('text')
const newChannelCategory = ref<string | null>(null)
const renamingCat = ref<string | null>(null)
const renamingCatValue = ref('')
const renamingChannel = ref<string | null>(null)
const renamingChannelValue = ref('')
const channelErr = ref('')

onMounted(() => {
  loadData()
})

async function loadData() {
  if (!serverStore.currentServer) return
  try {
    const data = await api.getServer(serverStore.currentServer.id)
    roles.value = data.roles
    members.value = data.members
  } catch {}
}

async function handleDelete() {
  if (!serverStore.currentServer) return
  if (!confirm(`确定解散 ${serverStore.currentServer.name}？此操作不可撤销！`)) return
  try {
    await serverStore.deleteServer(serverStore.currentServer.id)
    emit('close')
    router.push('/')
  } catch (e: any) {
    alert(e.message)
  }
}

async function handleLeave() {
  if (!serverStore.currentServer) return
  if (!confirm(`确定退出 ${serverStore.currentServer.name}？`)) return
  try {
    await serverStore.leaveServer(serverStore.currentServer.id)
    emit('close')
    router.push('/')
  } catch (e: any) {
    alert(e.message)
  }
}

async function handleSaveServer() {
  if (!serverStore.currentServer) return
  saving.value = true
  saveMsg.value = ''
  try {
    await serverStore.updateServerProfile({
      name: serverName.value.trim() || serverStore.currentServer.name,
      description: serverDesc.value
    })
    saveMsg.value = '保存成功'
  } catch (e: any) {
    saveMsg.value = e.message || '保存失败'
  } finally {
    saving.value = false
  }
}

async function handleServerAvatarUpload(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files?.length) return
  const file = input.files[0]
  try {
    const res = await api.uploadImage(file)
    if (res.url) {
      await serverStore.updateServerProfile({ avatar: res.url })
      saveMsg.value = '头像已更新'
    }
  } catch (e: any) {
    saveMsg.value = e.message || '上传失败'
  }
}

async function createCategory() {
  if (!serverStore.currentServer || !newCatName.value.trim()) return
  try {
    await serverStore.createCategory(serverStore.currentServer.id, newCatName.value.trim())
    newCatName.value = ''
  } catch (e: any) {
    channelErr.value = e.message || '创建失败'
  }
}

async function saveCategoryRename(catId: string) {
  if (!renamingCatValue.value.trim()) {
    renamingCat.value = null
    return
  }
  try {
    await serverStore.updateCategory(catId, renamingCatValue.value.trim())
  } catch (e: any) {
    channelErr.value = e.message || '保存失败'
  }
  renamingCat.value = null
}

async function removeCategory(catId: string) {
  if (!confirm('删除分组后，其下频道将移至"未分类"，确定删除？')) return
  try {
    await serverStore.deleteCategory(catId)
  } catch (e: any) {
    channelErr.value = e.message || '删除失败'
  }
}

async function createChannel() {
  if (!serverStore.currentServer || !newChannelName.value.trim()) return
  try {
    await serverStore.createChannel(serverStore.currentServer.id, {
      name: newChannelName.value,
      type: newChannelType.value,
      categoryId: newChannelCategory.value
    })
    newChannelName.value = ''
  } catch (e: any) {
    channelErr.value = e.message || '创建失败'
  }
}

async function saveChannelRename(chId: string) {
  if (!renamingChannelValue.value.trim()) {
    renamingChannel.value = null
    return
  }
  try {
    await serverStore.updateChannel(chId, { name: renamingChannelValue.value.trim() })
  } catch (e: any) {
    channelErr.value = e.message || '保存失败'
  }
  renamingChannel.value = null
}

async function removeChannel(chId: string) {
  if (!confirm('确定删除该频道？频道内的消息将一并删除')) return
  try {
    await serverStore.deleteChannel(chId)
  } catch (e: any) {
    channelErr.value = e.message || '删除失败'
  }
}

function categoryChannels(catId: string | null) {
  return serverStore.channelsByCategory(catId)
}

async function handleTransfer(userId: string) {
  if (!confirm('确定转让群主身份？')) return
  try {
    await api.transferServer(serverStore.currentServer!.id, userId)
    await serverStore.fetchServer(serverStore.currentServer!.id)
  } catch (e: any) {
    alert(e.message)
  }
}

async function kickMember(userId: string) {
  if (!confirm('确定踢出该成员？')) return
  try {
    await api.kickMember({ serverId: serverStore.currentServer!.id, userId })
    await loadData()
  } catch (e: any) {
    alert(e.message)
  }
}

async function toggleMute(userId: string, muted: boolean) {
  try {
    await api.muteMember({ serverId: serverStore.currentServer!.id, userId, muted: !muted })
    await loadData()
  } catch {}
}

// Role editing
const editingRole = ref<Role | null>(null)

function startEditRole(role: Role) {
  editingRole.value = { ...role }
}

async function saveRole() {
  if (!editingRole.value) return
  try {
    await api.updateRole(editingRole.value.id, editingRole.value)
    editingRole.value = null
    await loadData()
  } catch (e: any) {
    alert(e.message)
  }
}

async function deleteRole(roleId: string) {
  if (!confirm('确定删除此角色？')) return
  try {
    await api.deleteRole(roleId)
    await loadData()
  } catch {}
}

async function createRole() {
  if (!serverStore.currentServer) return
  try {
    await api.createRole({ serverId: serverStore.currentServer.id, name: '新角色' })
    await loadData()
  } catch {}
}

function getMemberName(member: Member) {
  return member.user?.nickname || member.user?.username || '未知'
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="bg-discord-800 rounded-xl w-full max-w-3xl h-[92vh] md:h-[80vh] flex flex-col shadow-2xl overflow-hidden m-2 md:m-0">
      <div class="flex items-center justify-between gap-3 px-4 py-4 border-b border-discord-600 md:px-6">
        <h2 class="text-lg md:text-xl font-bold text-white truncate min-w-0">服务器设置 - {{ serverStore.currentServer?.name }}</h2>
        <button @click="emit('close')" class="text-discord-200 hover:text-white flex-shrink-0">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div class="flex flex-col md:flex-row flex-1 overflow-hidden">
        <div class="flex md:hidden gap-1 bg-discord-900 px-2 py-2 overflow-x-auto flex-shrink-0 border-b border-discord-600">
          <button v-for="t in tabs" :key="t.key" @click="activeTab = t.key"
                  class="flex-shrink-0 px-3 py-2 rounded text-sm whitespace-nowrap"
                  :class="activeTab === t.key ? 'bg-discord-500 text-white' : 'text-discord-200 hover:text-white hover:bg-discord-600'">
            {{ t.label }}
          </button>
        </div>
        <div class="hidden md:block w-48 bg-discord-900 p-3 space-y-1">
          <button v-for="t in tabs" :key="t.key" @click="activeTab = t.key"
                  class="w-full text-left px-3 py-2 rounded text-sm"
                  :class="activeTab === t.key ? 'bg-discord-500 text-white' : 'text-discord-200 hover:text-white hover:bg-discord-600'">
            {{ t.label }}
          </button>
        </div>

        <div class="flex-1 p-4 md:p-6 overflow-y-auto">
          <!-- Overview -->
          <div v-if="activeTab === 'overview'">
            <h3 class="text-lg font-bold text-white mb-4">服务器概览</h3>

            <div class="flex items-center gap-4 mb-5">
              <div class="relative group flex-shrink-0">
                <div class="w-16 h-16 rounded-2xl bg-discord-600 flex items-center justify-center overflow-hidden">
                  <img v-if="serverStore.currentServer?.avatar && serverStore.currentServer.avatar !== 'default'"
                       :src="serverStore.currentServer.avatar" class="w-full h-full object-cover" />
                  <span v-else class="text-white font-bold text-lg">
                    {{ serverStore.currentServer?.name?.charAt(0).toUpperCase() }}
                  </span>
                </div>
                <label v-if="isOwner"
                       class="absolute inset-0 bg-black/50 rounded-2xl flex items-center justify-center opacity-0 group-hover:opacity-100 cursor-pointer transition-opacity">
                  <svg class="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  <input type="file" accept="image/*" class="hidden" @change="handleServerAvatarUpload" />
                </label>
              </div>
              <div>
                <p class="text-white font-bold">{{ serverStore.currentServer?.name }}</p>
                <p class="text-discord-200 text-sm">创建于 {{ serverStore.currentServer?.createdAt?.slice(0, 10) }}</p>
              </div>
            </div>

            <div v-if="isOwner" class="space-y-3">
              <div>
                <label class="text-xs font-bold text-discord-200 uppercase">名称</label>
                <input v-model="serverName" class="input-discord w-full mt-1" maxlength="50" />
              </div>
              <div>
                <label class="text-xs font-bold text-discord-200 uppercase">描述</label>
                <textarea v-model="serverDesc" class="input-discord w-full mt-1 resize-none" rows="3"
                          maxlength="200" placeholder="介绍一下这个服务器..."></textarea>
              </div>
              <div class="flex items-center gap-3 flex-wrap">
                <button @click="handleSaveServer" :disabled="saving" class="btn-primary">
                  {{ saving ? '保存中...' : '保存修改' }}
                </button>
                <p v-if="saveMsg" :class="saveMsg === '保存成功' || saveMsg === '头像已更新' ? 'text-green' : 'text-red'" class="text-sm">{{ saveMsg }}</p>
              </div>
            </div>
            <div v-else class="space-y-3">
              <div>
                <label class="text-xs font-bold text-discord-200 uppercase">描述</label>
                <p class="text-discord-200">{{ serverStore.currentServer?.description || '无' }}</p>
              </div>
            </div>

            <div class="mt-8 space-y-2">
              <button v-if="isOwner" @click="handleDelete" class="btn-red">解散服务器</button>
              <button v-else @click="handleLeave" class="btn-red">退出服务器</button>
            </div>
          </div>

          <!-- Channel management -->
          <div v-if="activeTab === 'channels'">
            <h3 class="text-lg font-bold text-white mb-4">频道管理</h3>

            <p v-if="channelErr" class="text-red text-sm mb-3">{{ channelErr }}</p>

            <div class="bg-discord-900 rounded p-3 mb-4">
              <p class="text-xs text-discord-200 mb-2">新建分组</p>
              <div class="flex gap-2">
                <input v-model="newCatName" class="input-discord flex-1" placeholder="分组名称" maxlength="30" />
                <button @click="createCategory" class="btn-primary text-sm">创建</button>
              </div>
            </div>

            <div class="bg-discord-900 rounded p-3 mb-4">
              <p class="text-xs text-discord-200 mb-2">新建频道</p>
              <div class="space-y-2">
                <div class="flex gap-2 flex-wrap">
                  <div class="flex gap-1 flex-shrink-0">
                    <button @click="newChannelType = 'text'"
                            class="px-3 py-2 rounded text-xs font-bold"
                            :class="newChannelType === 'text' ? 'bg-blurple text-white' : 'bg-discord-700 text-discord-200 hover:text-white'">
                      # 文字
                    </button>
                    <button @click="newChannelType = 'voice'"
                            class="px-3 py-2 rounded text-xs font-bold"
                            :class="newChannelType === 'voice' ? 'bg-blurple text-white' : 'bg-discord-700 text-discord-200 hover:text-white'">
                      🔊 语音
                    </button>
                  </div>
                  <input v-model="newChannelName" class="input-discord flex-1 min-w-[160px]" placeholder="频道名称" maxlength="30" />
                </div>
                <div class="flex gap-2">
                  <select v-model="newChannelCategory" class="input-discord flex-1">
                    <option :value="null">无分组</option>
                    <option v-for="cat in serverStore.sortedCategories" :key="cat.id" :value="cat.id">
                      {{ cat.name }}
                    </option>
                  </select>
                  <button @click="createChannel" class="btn-primary text-sm flex-shrink-0">创建</button>
                </div>
              </div>
            </div>

            <div class="space-y-3">
              <div v-for="cat in serverStore.sortedCategories" :key="cat.id">
                <div class="flex items-center justify-between px-2 py-1">
                  <div class="flex items-center gap-1 flex-1 min-w-0">
                    <svg class="w-3 h-3 text-discord-200 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                    </svg>
                    <span v-if="renamingCat !== cat.id" class="text-xs font-bold text-discord-200 uppercase tracking-wider truncate">
                      {{ cat.name }}
                    </span>
                    <input v-else v-model="renamingCatValue" class="input-discord text-xs py-0.5 flex-1" autofocus
                           @blur="saveCategoryRename(cat.id)" @keyup.enter="saveCategoryRename(cat.id)" />
                  </div>
                  <div class="flex gap-1">
                    <button @click="renamingCat = cat.id; renamingCatValue = cat.name"
                            class="text-discord-200 hover:text-white text-xs" title="重命名分组">✏️</button>
                    <button @click="removeCategory(cat.id)" class="text-discord-200 hover:text-red text-xs" title="删除分组">🗑️</button>
                  </div>
                </div>
                <div class="pl-4 space-y-1">
                  <div v-for="ch in categoryChannels(cat.id)" :key="ch.id"
                       class="flex items-center justify-between bg-discord-800 rounded px-2 py-1.5">
                    <div class="flex items-center gap-1.5 flex-1 min-w-0">
                      <span class="text-discord-200 flex-shrink-0">{{ ch.type === 'text' ? '#' : '🔊' }}</span>
                      <span v-if="renamingChannel !== ch.id" class="text-white text-sm truncate">{{ ch.name }}</span>
                      <input v-else v-model="renamingChannelValue" class="input-discord text-xs py-0.5 flex-1" autofocus
                             @blur="saveChannelRename(ch.id)" @keyup.enter="saveChannelRename(ch.id)" />
                    </div>
                    <div class="flex gap-1 flex-shrink-0">
                      <button @click="renamingChannel = ch.id; renamingChannelValue = ch.name"
                              class="text-discord-200 hover:text-white text-xs" title="重命名频道">✏️</button>
                      <button @click="removeChannel(ch.id)" class="text-discord-200 hover:text-red text-xs" title="删除频道">🗑️</button>
                    </div>
                  </div>
                  <p v-if="categoryChannels(cat.id).length === 0" class="text-xs text-discord-300 px-2 py-1">
                    此分组暂无频道
                  </p>
                </div>
              </div>

              <div v-if="categoryChannels(null).length > 0">
                <div class="px-2 py-1 text-xs font-bold text-discord-200 uppercase tracking-wider">未分类</div>
                <div class="pl-4 space-y-1">
                  <div v-for="ch in categoryChannels(null)" :key="ch.id"
                       class="flex items-center justify-between bg-discord-800 rounded px-2 py-1.5">
                    <div class="flex items-center gap-1.5 flex-1 min-w-0">
                      <span class="text-discord-200 flex-shrink-0">{{ ch.type === 'text' ? '#' : '🔊' }}</span>
                      <span v-if="renamingChannel !== ch.id" class="text-white text-sm truncate">{{ ch.name }}</span>
                      <input v-else v-model="renamingChannelValue" class="input-discord text-xs py-0.5 flex-1" autofocus
                             @blur="saveChannelRename(ch.id)" @keyup.enter="saveChannelRename(ch.id)" />
                    </div>
                    <div class="flex gap-1 flex-shrink-0">
                      <button @click="renamingChannel = ch.id; renamingChannelValue = ch.name"
                              class="text-discord-200 hover:text-white text-xs" title="重命名频道">✏️</button>
                      <button @click="removeChannel(ch.id)" class="text-discord-200 hover:text-red text-xs" title="删除频道">🗑️</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Roles -->
          <div v-if="activeTab === 'roles'">
            <div class="flex items-center justify-between mb-4">
              <h3 class="text-lg font-bold text-white">角色管理</h3>
              <button v-if="isOwner" @click="createRole" class="btn-primary text-sm">创建角色</button>
            </div>

            <div v-if="editingRole" class="bg-discord-900 rounded p-4 mb-4">
              <h4 class="text-white font-bold mb-3">编辑角色: {{ editingRole.name }}</h4>
              <div class="space-y-3">
                <div class="flex gap-3 flex-col sm:flex-row">
                  <div class="flex-1">
                    <label class="text-xs text-discord-200">角色名称</label>
                    <input v-model="editingRole.name" class="input-discord w-full mt-1" />
                  </div>
                  <div class="w-full sm:w-24">
                    <label class="text-xs text-discord-200">颜色</label>
                    <input v-model="editingRole.color" type="color" class="input-discord w-full mt-1 h-9" />
                  </div>
                </div>

                <div>
                  <label class="text-xs text-discord-200 mb-2 block">权限</label>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <label v-for="(val, key) in editingRole.permissions" :key="key"
                           class="flex items-center gap-2 text-sm text-discord-100 cursor-pointer">
                      <input type="checkbox" :checked="val"
                             @change="editingRole.permissions[key] = !editingRole.permissions[key]"
                             class="accent-blurple" />
                      {{ { viewChannel: '查看频道', sendMessage: '发送消息', uploadFile: '上传文件', manageChannels: '管理频道', manageRoles: '管理角色', kick: '踢人', mute: '禁言', manageServer: '管理服务器' }[key] || key }}
                    </label>
                  </div>
                </div>

                <div class="flex gap-2 pt-2">
                  <button @click="saveRole" class="btn-primary text-sm">保存</button>
                  <button @click="editingRole = null" class="btn-ghost text-sm">取消</button>
                </div>
              </div>
            </div>

            <div class="space-y-2">
              <div v-for="role in roles" :key="role.id"
                   class="flex items-center justify-between bg-discord-900 rounded p-3">
                <div class="flex items-center gap-3">
                  <div class="w-4 h-4 rounded-full" :style="{ backgroundColor: role.color }"></div>
                  <span class="text-white text-sm font-medium">{{ role.name }}</span>
                  <span v-if="role.isDefault" class="text-xs text-discord-200">(默认)</span>
                </div>
                <div class="flex gap-2">
                  <button v-if="!role.isDefault && isOwner" @click="startEditRole(role)"
                          class="btn-ghost text-xs">编辑</button>
                  <button v-if="!role.isDefault && isOwner" @click="deleteRole(role.id)"
                          class="btn-ghost text-xs text-red">删除</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Members -->
          <div v-if="activeTab === 'members'">
            <h3 class="text-lg font-bold text-white mb-4">成员管理 ({{ members.length }})</h3>

            <div class="space-y-2">
              <div v-for="member in members" :key="member.userId"
                   class="flex items-center justify-between bg-discord-900 rounded p-3">
                <div class="flex items-center gap-3">
                  <Avatar :src="member.user?.avatar" :name="getMemberName(member)" size="sm" />
                  <div>
                    <span class="text-white text-sm font-medium">{{ getMemberName(member) }}</span>
                    <span v-if="member.userId === serverStore.currentServer?.ownerId"
                          class="text-xs text-yellow ml-2">群主</span>
                    <div class="text-xs text-discord-200">
                      {{ member.user?.status === 'online' ? '在线' : '离线' }}
                    </div>
                  </div>
                </div>
                <div v-if="isOwner && member.userId !== authStore.user?.id" class="flex gap-2">
                  <button @click="handleTransfer(member.userId)" class="btn-ghost text-xs">转让</button>
                  <button @click="kickMember(member.userId)" class="btn-ghost text-xs text-red">踢出</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
