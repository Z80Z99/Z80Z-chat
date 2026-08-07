// 美术优化断言脚本（零依赖）：检查构建后的 CSS 是否包含约定的全局样式规则
// 用法: node frontend/scripts/check-art.mjs （需先 npm run build）
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distCss = path.join(__dirname, '..', '..', 'dist', 'assets')
const files = fs.readdirSync(distCss).filter(f => f.endsWith('.css'))
if (files.length === 0) {
  console.error('✖ 未找到 dist/assets/*.css，请先 npm run build')
  process.exit(1)
}
// 主样式文件（index-*.css 是 vite 打包的入口样式）
const css = files
  .filter(f => /^index-/.test(f))
  .map(f => fs.readFileSync(path.join(distCss, f), 'utf8'))
  .join('\n')
// 组件异步 chunk 可能包含样式，也扫一遍
const allCss = files.map(f => fs.readFileSync(path.join(distCss, f), 'utf8')).join('\n')

const rules = [
  ['CJK 字体栈（PingFang 在 Segoe 前）', /PingFang SC[\s\S]{0,120}Segoe UI/],
  ['antialiased 字体平滑', /-webkit-font-smoothing:\s*antialiased/],
  ['::selection 选择色', /::selection/],
  [':focus-visible 焦点环', /:focus-visible/],
  ['tap-highlight 透明', /-webkit-tap-highlight-color:\s*transparent/],
  ['keyframes fade-in-up', /@keyframes\s+fade-in-up/],
  ['keyframes scale-in', /@keyframes\s+scale-in/],
  ['keyframes message-in', /@keyframes\s+message-in/],
  ['prefers-reduced-motion', /prefers-reduced-motion/],
  ['auth-bg 氛围背景类', /\.auth-bg/],
  ['auth-card 卡片类', /\.auth-card/],
  ['btn-gradient 渐变按钮', /\.btn-gradient/],
  ['modal-overlay 动画', /\.modal-overlay\s*\{[^}]*animation:/],
  ['modal-content 动画', /\.modal-content\s*\{[^}]*animation:/],
  ['context-menu 动画', /\.context-menu\s*\{[^}]*animation:/],
  ['sidebar-item 指示条', /\.sidebar-item:?:?before/]
]

let failed = 0
for (const [name, re] of rules) {
  const ok = re.test(allCss)
  if (!ok) {
    failed++
    console.log('✖ 缺失: ' + name)
  }
}
if (failed === 0) {
  console.log('✔ 全部 ' + rules.length + ' 项美术约定已就位')
  process.exit(0)
} else {
  console.log(`✖ ${failed}/${rules.length} 项缺失`)
  process.exit(1)
}
