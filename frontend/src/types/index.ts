export interface User {
  id: string
  username: string
  nickname: string
  avatar: string
  status: 'online' | 'idle' | 'dnd' | 'offline'
  bio: string
  createdAt: string
}

export interface Server {
  id: string
  name: string
  avatar: string
  description: string
  ownerId: string
  createdAt: string
}

export interface Category {
  id: string
  serverId: string
  name: string
  position: number
}

export interface Channel {
  id: string
  serverId: string
  categoryId: string | null
  name: string
  type: 'text' | 'voice'
  position: number
  permissions: Record<string, any>
}

export interface Message {
  id: string
  channelId: string
  userId: string
  content: string
  image: string | null
  file: string | null
  fileName: string | null
  createdAt: string
  editedAt: string | null
  replyTo: string | null
  mentions: string[]
  mentionEveryone: boolean
  user?: User
}

export interface Role {
  id: string
  serverId: string
  name: string
  color: string
  permissions: Permissions
  position: number
  isDefault: boolean
}

export interface Permissions {
  viewChannel: boolean
  sendMessage: boolean
  uploadFile: boolean
  mentionEveryone: boolean
  manageChannels: boolean
  manageRoles: boolean
  manageMessages: boolean
  kick: boolean
  mute: boolean
  manageServer: boolean
}

export interface Member {
  serverId: string
  userId: string
  roles: string[]
  joinedAt: string
  user?: User
  muted?: boolean
}

export interface Invite {
  id: string
  code: string
  serverId: string
  creatorId: string
  maxUses: number | null
  uses: number
  expiresAt: string | null
  createdAt: string
}

export interface FriendRelation {
  id: string
  status: 'pending' | 'accepted'
  direction: 'incoming' | 'outgoing'
  friend: User | null
}

export interface WSMessage {
  type: string
  [key: string]: any
}
