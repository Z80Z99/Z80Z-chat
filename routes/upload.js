// ============================================================
// Z80Z-chat - 上传路由
// 用途：图片/文件上传（UUID 文件名、扩展名白名单锚定、大小限制）
// 来源：Z80Z-chat v1.0.0 合法项目代码
// 说明：如被杀毒软件误报（启发式误报），请将项目目录加入信任区
// ============================================================
import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'node:fs'
import { TextDecoder } from 'node:util'
import config, { uploadDir } from '../config/index.js'
import { authMiddleware } from '../middlewares/auth.js'
import { genId } from '../utils/helpers.js'
import { logger } from '../utils/logger.js'
import { hasPermission } from '../utils/permissions.js'
import { readImageInfo, validCommunityDimensions } from '../utils/server-profile.js'

const utf8FilenameDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function normalizeOriginalName(filename) {
  // Multer 的普通 filename 参数按 Latin-1 解码；浏览器发送的原始字节通常为 UTF-8。
  // 已正确解析的 Unicode（例如 filename*）不能再次截断成 Latin-1 字节。
  if (!/^[\u0000-\u00ff]*$/.test(filename)) return filename
  try {
    return utf8FilenameDecoder.decode(Buffer.from(filename, 'latin1'))
  } catch {
    // 非 UTF-8 的旧客户端名称保留原值，不以替换字符破坏文件名。
    return filename
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir)
  },
  filename: (req, file, cb) => {
    // UUID 文件名（不可预测），保留原扩展名
    const ext = path.extname(file.originalname).toLowerCase()
    cb(null, genId() + ext)
  }
})

const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadSizeMB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    file.originalname = normalizeOriginalName(file.originalname)
    // 锚定整个扩展名字符串，防止 tjpeg 等子串绕过
    const allowedTypes = new RegExp(`^(${config.allowedUploadTypes})$`)
    const ext = path.extname(file.originalname).toLowerCase().slice(1)
    if (allowedTypes.test(ext)) {
      cb(null, true)
    } else {
      cb(new Error('不支持的文件类型'))
    }
  }
})

const router = Router()

router.post('/community/:serverId/:kind', authMiddleware, (req, res) => {
  const db = req.app.locals.db, { serverId, kind } = req.params
  if (kind !== 'avatar' && kind !== 'banner') return res.status(400).json({ error: '图片用途无效' })
  if (!db.findServer(serverId)) return res.status(404).json({ error: '服务器不存在' })
  const canUpload = () => db.findMember(serverId, req.user.id) && hasPermission(db, req.user.id, serverId, 'manageServer')
  if (!canUpload()) return res.status(403).json({ error: '没有管理社区的权限' })
  const fileSize = Math.min(config.maxUploadSizeMB, kind === 'avatar' ? 2 : 5) * 1024 * 1024
  const communityUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize, files: 1 },
    fileFilter: (request, file, callback) => {
      file.originalname = normalizeOriginalName(file.originalname)
      const ext = path.extname(file.originalname).toLowerCase()
      if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext) || !['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) return callback(new Error('社区图片仅支持 PNG、JPEG 和 WebP'))
      callback(null, true)
    } })
  communityUpload.single('file')(req, res, error => {
    if (error) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? `图片不能超过${fileSize / 1024 / 1024}MB` : '图片上传格式无效' })
    if (!canUpload()) return res.status(403).json({ error: '没有管理社区的权限' })
    if (!req.file) return res.status(400).json({ error: '请选择图片' })
    const info = readImageInfo(req.file.buffer)
    const extension = path.extname(req.file.originalname).toLowerCase()
    const correctType = info && req.file.mimetype === `image/${info.format}` && (info.format === 'jpeg' ? ['.jpg', '.jpeg'].includes(extension) : extension === '.' + info.format)
    if (!correctType) return res.status(400).json({ error: '图片内容与文件类型不符或图片损坏' })
    if (!validCommunityDimensions(info, kind)) return res.status(400).json({ error: kind === 'avatar' ? '头像须为128–1024像素的正方形' : '横幅须为4:1，宽400–3200像素、高100–800像素' })
    const filename = genId() + (info.format === 'jpeg' ? '.jpg' : '.' + info.format), filePath = path.join(uploadDir, filename)
    try { fs.writeFileSync(filePath, req.file.buffer, { flag: 'wx' }) }
    catch (writeError) {
      if (writeError.code !== 'EEXIST') { try { fs.unlinkSync(filePath) } catch {} }
      logger.error('社区图片保存失败: ' + (writeError?.message || writeError))
      return res.status(500).json({ error: '图片保存失败，请重试' })
    }
    res.json({ url: '/uploads/' + filename, filename: req.file.originalname, width: info.width, height: info.height, kind })
  })
})

router.post('/image', authMiddleware, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      logger.warn(`图片上传失败（${req.user?.username}）: ${err.message || err}`)
      return res.status(400).json({ error: err.message || '上传失败' })
    }
    if (!req.file) return res.status(400).json({ error: '请选择文件' })

    const url = '/uploads/' + req.file.filename
    res.json({ url, filename: req.file.originalname })
  })
})

router.post('/file', authMiddleware, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      logger.warn(`文件上传失败（${req.user?.username}）: ${err.message || err}`)
      return res.status(400).json({ error: err.message || '上传失败' })
    }
    if (!req.file) return res.status(400).json({ error: '请选择文件' })

    const url = '/uploads/' + req.file.filename
    res.json({ url, filename: req.file.originalname, size: req.file.size })
  })
})

export default router
