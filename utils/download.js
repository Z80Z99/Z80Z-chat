// 通用下载工具：流式下载到目标文件（.tmp 暂存 + 进度显示），供部署脚本复用
import fs from 'fs'
import path from 'path'

// 下载 url 到 dest。成功返回 { ok: true }；失败返回 { ok: false, error } 并清理 .tmp。
// opts.dim: 可选颜色函数（start.js 传入 dim 以保持视觉一致）
export async function downloadWithProgress(url, dest, { dim = (s) => s } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = dest + '.tmp'
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const total = Number(res.headers.get('content-length')) || 0
    const out = fs.createWriteStream(tmp)
    const reader = res.body.getReader()
    let received = 0
    let lastPct = -1
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      out.write(Buffer.from(value))
      const pct = total ? Math.floor((received / total) * 100) : -1
      if (pct !== lastPct && (pct % 10 === 0 || pct === -1)) {
        lastPct = pct
        const txt = total
          ? `${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB (${pct}%)`
          : `${(received / 1048576).toFixed(1)} MB`
        process.stdout.write('\r  ' + dim('下载中 ... ' + txt) + '   ')
      }
    }
    process.stdout.write('\r  ' + dim(`下载完成 ${(received / 1048576).toFixed(1)} MB`) + '   \n')
    await new Promise((resolve, reject) => { out.end(() => resolve()); out.on('error', reject) })
    fs.renameSync(tmp, dest)
    return { ok: true }
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch {}
    return { ok: false, error: e?.message || String(e) }
  }
}
