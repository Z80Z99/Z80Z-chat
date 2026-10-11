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
  ['sidebar-item 指示条', /\.sidebar-item:?:?before/],
  ['语义颜色变量', /--chat-color-main:/],
  ['4px 间距与圆角变量', /--chat-space-1:\s*4px[\s\S]*--chat-radius-lg:/],
  ['聊天正文样式保留', /\.message-entry\s+\.message-content/],
  ['输入区焦点状态', /\.composer-surface:focus-within/],
  ['底部消息操作面板', /\.message-action-sheet/],
  ['移动操作按钮触摸尺寸', /\.message-action-button\s*\{[^}]*min-height:\s*48px/],
  ['动态可见视口高度', /height:\s*var\(--chat-viewport-height/],
  ['安全区域底距', /env\(safe-area-inset-bottom\)/],
  ['键盘状态隐藏导航', /\.chat-keyboard-open\s+\.chat-mobile-nav\s*\{[^}]*display:\s*none/],
  ['回应计数与选中态', /\.message-reaction-chip\[aria-pressed/],
  ['回应成员名单', /\.message-reaction-member-names/],
  ['历史定位高亮', /\.message-entry\.message-entry-highlighted/],
  ['置顶及搜索面板', /\.message-find-panel/],
  ['搜索表单触摸尺寸', /\.message-find-form[^}]*min-height:\s*44px/],
  ['成员提及高亮', /\.message-mention\s*\{[^}]*background:/],
  ['被提及消息标记', /\.message-entry\.message-entry-mentioned/],
  ['提及候选触摸尺寸', /\.composer-mention-option\s*\{[^}]*min-height:\s*44px/],
  ['通知面板及安全区域', /\.notification-panel\s*\{[^}]*safe-area-inset-bottom/],
  ['频道提及徽标', /\.channel-mention-count\s*\{/],
  ['通知入口计数', /\.notification-trigger-count\s*\{/],
  ['本地设备测试触摸尺寸', /\.audio-device-test-button\s*\{[^}]*min-height:\s*44px/],
  ['本地麦克风电平', /\.audio-device-test-meter-fill\s*\{/],
  ['语音设备选择触摸尺寸', /\.voice-device-select[^}]*min-height:\s*44px/],
  ['按住说话触摸尺寸', /\.voice-ptt-hold\s*\{[^}]*min-height:\s*48px/],
  ['按住说话反馈', /\.voice-ptt-hold\[aria-pressed/],
  ['成员音量行', /\.voice-volume-row\s*\{/],
  ['影院隐藏导航后的布局', /\.voice-cinema\s+\.voice-room-content\s*\{[^}]*max-width:\s*none/],
  ['投屏画面选择触摸尺寸', /\.screen-stage-picker\s+select\s*\{[^}]*min-height:\s*44px/],
  ['影院返回触摸尺寸', /\.screen-stage-cinema-toggle\s*\{[^}]*min-height:\s*44px/],
  ['视频播放控件触摸尺寸', /\.screen-playback-button\s*\{[^}]*min-height:\s*44px/],
  ['诊断面板与内容滚动', /\.voice-diagnostics-content\s*\{[^}]*overflow-y:\s*auto/],
  ['诊断关闭触摸尺寸', /\.voice-diagnostics-close\s*\{[^}]*min-height:\s*44px/],
  ['影院手机安全区域', /\.chat-app-shell\.voice-cinema\s*\{[^}]*padding-bottom:\s*env\(safe-area-inset-bottom\)/],
  ['影院通话控制不遮挡视频', /\.voice-cinema\s+\.voice-room-controls\s*\{[^}]*position:\s*static/],
  ['影院单画面撑满可用高度', /\.screen-share-stage-cinema\s+\.screen-stage-grid-single\s*\{[^}]*align-items:\s*stretch/],
  ['共享视频限定在播放器内并保持比例', /\.screen-share-video\s*\{[^}]*position:\s*absolute;[^}]*object-fit:\s*contain/],
  ['社区横幅统一比例', /\.community-banner\s*\{[^}]*aspect-ratio:\s*4\s*\/\s*1/],
  ['社区文字保留换行', /\.community-preserve-text\s*\{[^}]*white-space:\s*pre-wrap/],
  ['推荐频道触摸目标', /\.community-channel-button\s*\{[^}]*min-height:\s*76px/],
  ['社区资料编辑布局', /\.community-profile-form\s*\{/],
  ['图片裁切预览容器', /\.community-crop-preview\s*\{/],
  ['公告频道只读提示', /\.announcement-read-only\s*\{/]
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
