// ============================================================
// NodeChat - 上传路由
// 用途：图片/文件上传（UUID 文件名、扩展名白名单锚定、大小限制）
// 来源：NodeChat v1.0.0 合法项目代码
// 说明：如被杀毒软件误报（启发式误报），请将项目目录加入信任区
// ============================================================
import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import config, { uploadDir } from '../config/index.js'
import { authMiddleware } from '../middlewares/auth.js'
import { genId } from '../utils/helpers.js'
import { logger } from '../utils/logger.js'

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
