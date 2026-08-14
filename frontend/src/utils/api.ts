const BASE = '/api'

function getToken(): string | null {
  return localStorage.getItem('token')
}

async function request(path: string, options: RequestInit = {}): Promise<any> {
  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {})
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE}${path}`, { ...options, headers })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || '请求失败')
  return data
}

export const api = {
  // Auth
  register(username: string, password: string) {
    return request('/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) })
  },
  login(username: string, password: string) {
    return request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) })
  },
  me() {
    return request('/auth/me')
  },
  logout() {
    return request('/auth/logout', { method: 'POST' })
  },

  // Users
  getUser(id: string) {
    return request(`/users/${id}`)
  },
  updateUser(data: any) {
    return request('/users/update', { method: 'POST', body: JSON.stringify(data) })
  },
  changePassword(oldPassword: string, newPassword: string) {
    return request('/users/change-password', { method: 'POST', body: JSON.stringify({ oldPassword, newPassword }) })
  },
  searchUsers(query: string) {
    return request(`/users/search/${encodeURIComponent(query)}`)
  },

  // Servers
  createServer(data: any) {
    return request('/servers/create', { method: 'POST', body: JSON.stringify(data) })
  },
  getServers() {
    return request('/servers/list')
  },
  getServer(id: string) {
    return request(`/servers/${id}`)
  },
  transferServer(id: string, userId: string) {
    return request(`/servers/transfer/${id}`, { method: 'POST', body: JSON.stringify({ userId }) })
  },
  deleteServer(id: string) {
    return request(`/servers/${id}`, { method: 'DELETE' })
  },
  updateServer(id: string, data: any) {
    return request(`/servers/${id}`, { method: 'PUT', body: JSON.stringify(data) })
  },
  joinServer(code: string) {
    return request('/servers/join', { method: 'POST', body: JSON.stringify({ code }) })
  },
  leaveServer(id: string) {
    return request(`/servers/leave/${id}`, { method: 'POST' })
  },

  // Channels
  createChannel(data: any) {
    return request('/channels/create', { method: 'POST', body: JSON.stringify(data) })
  },
  updateChannel(id: string, data: any) {
    return request(`/channels/${id}`, { method: 'PUT', body: JSON.stringify(data) })
  },
  deleteChannel(id: string) {
    return request(`/channels/${id}`, { method: 'DELETE' })
  },

  // Categories
  createCategory(data: any) {
    return request('/categories/create', { method: 'POST', body: JSON.stringify(data) })
  },
  updateCategory(id: string, data: any) {
    return request(`/categories/${id}`, { method: 'PUT', body: JSON.stringify(data) })
  },
  deleteCategory(id: string) {
    return request(`/categories/${id}`, { method: 'DELETE' })
  },

  // Messages
  getMessages(channelId: string, limit = 50, before?: string) {
    let url = `/messages/list/${channelId}?limit=${limit}`
    if (before) url += `&before=${before}`
    return request(url)
  },
  sendMessage(data: any) {
    return request('/messages/send', { method: 'POST', body: JSON.stringify(data) })
  },
  editMessage(id: string, content: string) {
    return request(`/messages/${id}`, { method: 'PUT', body: JSON.stringify({ content }) })
  },
  deleteMessage(id: string) {
    return request(`/messages/${id}`, { method: 'DELETE' })
  },

  // Roles
  createRole(data: any) {
    return request('/roles/create', { method: 'POST', body: JSON.stringify(data) })
  },
  updateRole(id: string, data: any) {
    return request(`/roles/${id}`, { method: 'PUT', body: JSON.stringify(data) })
  },
  deleteRole(id: string) {
    return request(`/roles/${id}`, { method: 'DELETE' })
  },

  // Members
  getMembers(serverId: string) {
    return request(`/members/list/${serverId}`)
  },
  kickMember(data: any) {
    return request('/members/kick', { method: 'POST', body: JSON.stringify(data) })
  },
  muteMember(data: any) {
    return request('/members/mute', { method: 'POST', body: JSON.stringify(data) })
  },

  // Invites
  createInvite(data: any) {
    return request('/invites/create', { method: 'POST', body: JSON.stringify(data) })
  },
  getInvites(serverId: string) {
    return request(`/invites/list/${serverId}`)
  },
  deleteInvite(id: string) {
    return request(`/invites/${id}`, { method: 'DELETE' })
  },
  inviteFriend(serverId: string, userId: string) {
    return request('/invites/friend', { method: 'POST', body: JSON.stringify({ serverId, userId }) })
  },

  // Friends
  getFriends() {
    return request('/friends/list')
  },
  addFriend(username: string) {
    return request('/friends/add', { method: 'POST', body: JSON.stringify({ username }) })
  },
  acceptFriend(friendId: string) {
    return request('/friends/accept', { method: 'POST', body: JSON.stringify({ friendId }) })
  },
  removeFriend(friendId: string) {
    return request(`/friends/${friendId}`, { method: 'DELETE' })
  },

  // Upload
  uploadImage(file: File) {
    const formData = new FormData()
    formData.append('file', file)
    const token = getToken()
    return fetch(`${BASE}/upload/image`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData
    }).then(r => r.json())
  },
  uploadFile(file: File) {
    const formData = new FormData()
    formData.append('file', file)
    const token = getToken()
    return fetch(`${BASE}/upload/file`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData
    }).then(r => r.json())
  }
}
