// 统一权限检查工具
// 逻辑：服务器不存在或非成员 → false；服务器拥有者 → true；
//       成员角色权限取并集（任一角色拥有该权限即授予）；@everyone 兜底
export function hasPermission(db, userId, serverId, permission) {
  const server = db.findServer(serverId)
  if (!server) return false
  if (server.ownerId === userId) return true
  const member = db.findMember(serverId, userId)
  if (!member) return false
  for (const roleId of member.roles) {
    const role = db.findRole(roleId)
    if (role && role.permissions?.[permission]) return true
  }
  const defaultRole = db.findDefaultRole(serverId)
  if (defaultRole && defaultRole.permissions?.[permission]) return true
  return false
}

// 用户在该服务器的最高角色 position（无任何角色时为 -1）
export function userMaxPosition(db, userId, serverId) {
  const member = db.findMember(serverId, userId)
  if (!member) return -1
  let max = -1
  for (const roleId of member.roles) {
    const role = db.findRole(roleId)
    if (role && role.position > max) max = role.position
  }
  return max
}

// 角色层级检查：owner 豁免；其余用户仅能操作 position 严格低于自己最高角色的角色
export function canManageRole(db, userId, serverId, targetRole) {
  const server = db.findServer(serverId)
  if (!server || !targetRole) return false
  if (server.ownerId === userId) return true
  return targetRole.position < userMaxPosition(db, userId, serverId)
}
