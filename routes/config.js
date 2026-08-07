import { Router } from 'express'
import config from '../config/index.js'

const router = Router()

router.get('/', (req, res) => {
  res.json({
    siteName: config.siteName,
    iceServers: config.iceServers
  })
})

export default router
