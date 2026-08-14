# AGENTS.md — Z80Z-chat 项目工作说明

本文件是给 opencode / AI 助手的工作上下文。每次开始修改本项目前先读本文件。

## 项目简介

仿 Discord 风格的社区聊天系统，100% 本地运行、零外部服务依赖（无数据库、无云服务）。
纯 Node.js + 原生 WebSocket，前端 Vue 3 单页应用。

## 技术栈与运行

- 后端：Node.js + Express + ws（ESM 模块，package.json `"type": "module"`）
- 前端：Vue 3 + Pinia + Vue Router + Tailwind CSS + TypeScript（位于 `frontend/`）
- 存储：本地 JSON 文件（`data/db.json`）+ 文件上传（`data/uploads/`）
- 密码：bcryptjs；上传：multer
- 启动：双击 `start.bat`（推荐，带交互菜单），或 `npm run dev`（开发热更新）
- 构建：`npm run build`（前端产物输出到 `frontend/dist`，由 server.js 静态托管）

## 目录结构

```
z80z-chat/
├── start.bat          # 启动器（必须纯 ASCII，见下方编码坑）
├── start.js           # 交互式部署管理脚本（主入口，现代 UI）
├── server.js          # Express 服务器（端口/防火墙由 start.js 管理）
├── config.json        # 部署配置（含中文注释，记事本可编辑）
├── config/index.js    # 配置加载器（剥注释、默认值深合并、PORT/HOST 环境变量覆盖）
├── models/db.js       # JSON 数据库（启动时自动重建 data 目录和空库）
├── routes/            # REST API（auth/users/servers/channels/categories/messages/roles/members/invites/friends/upload/config）
├── websocket/         # WS 服务：消息推送 + 语音/投屏信令转发
│   └── index.js       # relay 事件白名单：voice-offer / voice-answer / voice-ice-candidate / screen-refresh
├── webrtc/signaling.js
├── utils/helpers.js
├── data/              # 运行时数据（db.json / uploads / server.pid），删除后自动重建
└── frontend/src/
    ├── stores/        # Pinia：auth / chat / server / presence / voice
    │   └── voice.ts   # WebRTC 语音+投屏核心（见下方架构）
    ├── components/ScreenShareVideo.vue  # 投屏观看组件
    ├── views/Home.vue # 主界面（使用 ScreenShareVideo）
    └── vite.config.ts # dev 代理端口从 config 读取
```

## 配置体系（重要约定）

- `config.json` 是唯一用户可编辑的配置文件，**支持中文注释（每行一个，写在上方）**
- `config/index.js` 加载逻辑：先按行剥注释 → 与内置默认值深合并 → 支持 `PORT`/`HOST` 环境变量覆盖
- 当前默认值：端口 3000、host 0.0.0.0、数据目录 data、上传上限 10MB、ICE 谷歌 STUN、上传签名有效期 7 天（`uploadUrlExpiresSec`）、签名密钥 `uploadSecret`（留空自动生成存 `data/.upload-secret`）
- 新增配置项时：config.json 加注释条目 → config/index.js 的 defaults 同步加 → 使用处读取
- 服务器读取：port/host/bodyLimit/corsOrigins/wsPath 在 server.js；上传限制在 routes/upload.js；dataDir/dbPath/uploadDir 由 config/index.js 导出

## 部署脚本 start.js（本会话近期工作重点）

- 交互式菜单：主菜单按服务状态分两套选项
  - 未运行：1 启动服务 / 2 备份管理 / 3 查看配置 / 4 编辑配置 / 5 项目说明 / 6 隧道管理 / 7 切换版本 / 8 项目清档(红色危险项) / 0 退出
  - 运行中：1 重启服务 / 2 停止服务 / 3 备份管理 / 4 查看配置 / 5 编辑配置 / 6 项目说明 / 7 隧道管理 / 8 切换版本 / 9 项目清档 / 0 退出
  - 部署后：运行中菜单（1 转入后台静默运行 / 2 停止服务返回主菜单）；直接关窗=停止服务
- UI 风格约定（后续改动必须保持）：`header()` 为「标题 + accent 全宽分隔线」简洁样式（用户明确要求不要用 ╭─╮ 方框）；菜单项 `N. 标签 · 灰色说明`（无 ▸）；危险项用红色 dangerItem；退出/取消/返回统一用 0；提示 `> `；次要信息用 dim；waitKey 返回提示 `[ 按回车返回 ]`；ANSI 256 色，非 TTY 或 `--no-color` 自动降级
- 关键参数：`--no-firewall` 跳过防火墙（自动化测试必须加，UAC 授权弹窗会卡住/杀掉工具会话）；`--no-color` 关颜色
- 防火墙：临时 ps1 + UAC 提权，规则名来自 config.firewall.ruleName（当前 "Z80Z-chat"）；拒绝授权时只警告不中断
- 后台运行：PID 写入 `data/server.pid`；停止服务优先按 PID 文件杀，失败按端口 netstat 兜底

## Windows 环境坑（重要）

- **start.bat 必须纯 ASCII**：cmd 用 GBK 解码 UTF-8 中文会乱码报错（如 `'hat' 不是内部或外部命令`）。改 bat 后验证：确认文件无非 ASCII 字节
- 端口占用处理：netstat + taskkill /F /PID
- 自动化测试部署流程时用 `--no-firewall`，避免 UAC 弹窗

## 语音 / 投屏架构（近期修复重点）- 信令走 WebSocket relay（websocket/index.js 白名单事件）
- `frontend/src/stores/voice.ts`：
  - `remoteScreens` 是响应式数组 `{userId, stream, ts}`（不是 Map），ScreenShareVideo 通过 props 传入
  - `ensureIceServers()`：fetch `/api/config`（返回 {iceServers}），失败回退谷歌 STUN；joinRoom 前必须 await
  - 发送端 `setCodecPreferences`：H264 > VP8，明确排除 VP9（避免接收端黑屏）
  - `requestScreenRefresh()`：iceRestart + 确保 video transceiver，用于黑屏自救
  - `screenDebug`（pushScreenDebug）用于诊断
- `ScreenShareVideo.vue`：状态机（waiting/loading/playing/black/error），黑屏检测自动触发 refresh；控制条仅保留 播放/暂停 + 全屏（用户要求精简）
- 新增 WS 事件必须同步加进 websocket/index.js 的白名单 relay case

## 隧道管理（Cloudflare Tunnel / SakuraFRP）

「隧道管理」主入口现在是**服务选择页**（start.js `tunnelMenu()`）：`1. Cloudflare Tunnel`（进 `cfMenu()`）/ `2. SakuraFRP`（进 `sfpMenu()`）。

### Cloudflare Tunnel（cf* 函数族）

- cloudflared 与 Node.js 同模式：**不内嵌二进制**，按需下载到外层 `cloudflared/` 目录（`outerRoot/cloudflared/cloudflared.exe`）
- 下载流程镜像 Node.js 安装向导：说明页（为什么需要）→ **网络线路选择**（HEAD 测速 + 颜色分级，留空自动选最快，源：GitHub 官方 / ghproxy.net / gh-proxy.com）→ 下载（进度显示）→ `--version` 校验 → 完成（约 54MB 单 exe，无解压无管理员）
- 关键文件（均在 `cloudflared/` 下）：`cloudflared.exe`、`config.yml`（每次启动按当前 config.json 端口重写）、`.cloudflared.pid`、`settings.json`
- `settings.json`：`{ tunnelId, hostname }`，hostname 默认 `chat.z80z99.cn`，可改此文件自定义域名
- 隧道 ID 获取顺序：settings 缓存 → `tunnel list` 正则解析 → `tunnel info` 解析 → 创建时从输出提取
- 首次配置向导（start.js `cfWizard()`）：login（浏览器授权）→ create → route dns → 写 config.yml → 可选立即启动；login/route 用 `spawnSync` + `stdio: inherit`（需用户交互）
- 启动：`spawn(exe, ['tunnel','--config',CF_CONFIG_FILE,'run','z80z-chat'], {detached, windowsHide})`，PID 写入 `.cloudflared.pid`；停止按 PID taskkill
- 公网可达检测：启动后 fetch `https://<hostname>/api/config`（30 秒超时轮询）
- 注意：隧道进程与 Z80Z-chat 服务相互独立，停止服务不会停隧道（反之亦然）；未登录/未创建隧道时启动会给出明确提示

### SakuraFRP（sfp* 函数族）

- frpc 下载链接为**面板账号专属**（https://www.natfrp.com/user/ → 软件下载），无法硬编码公开 URL，向导引导用户粘贴
- 关键文件（均在 `sakurafrp/` 下）：`frpc.exe`、`frpc.ini`（TUI 交互模式生成）、`.sakurafrp.pid`、`settings.json`、`frpc.log`
- `settings.json`：`{ token, tunnelId, mode, accessUrl }`，mode 为 `tui`（frpc 无参数启动读 frpc.ini）或 `cli`（`-f 密钥:隧道ID`）
- 隧道必须在网页面板创建（本地 IP 127.0.0.1，本地端口 = config.port，类型 HTTP/HTTPS 兼容 WebSocket）
- 启动：`spawn(exe, args, {cwd: SFP_DIR, detached, stdio: [ignore, log, log]})`；访问地址从 frpc.log 正则解析，可手动在 settings.json 填 accessUrl
- 交互模式配置：`spawnSync(exe, [], {cwd: SFP_DIR, stdio: 'inherit'})` 运行 TUI（输入 Token → 勾选隧道 → Ctrl-C 生成 frpc.ini）
- 免费额度：2 隧道 / 10Mbps / 5GiB 每月（签到可领），语音投屏走 WebRTC 不占流量

## 智能快速更新（智能快速更新）

- 构建时（build-single.js `computePayloadSha`）计算**内容指纹**：zip 条目剔除 package.json，按相对路径排序后逐文件 sha256 → 整体 sha256，注入 bat 头部 `PAYLOAD_SHA`（cmd 层 → PS param `$PayloadSha`）
- 安装端判定（install.template.bat `Update()`）：解压 zip 到临时目录 → `Compute-PayloadSha` 与 PAYLOAD_SHA 比较 → 与 `.install-version` 记录的 payloadHash 比较 → `Get-DepsKey`（dependencies+devDependencies，**排除 version**）比较 → node_modules/dist 存在
- 全满足：快速路径 = 跳过备份/npm install/build，仅 Rebuild-Project（保留 data/logs/node_modules/config.json）+ Write-Project + Write-VersionMarker；公共收尾（改名 + 完成界面）在 `Finish-Update`
- 指纹算法必须与构建端一致：相对路径用 `/`、Ordinal 排序、UTF-8 文件名、内容逐文件 sha256
- 修改 build-single.js 的打包/指纹逻辑时，必须同步改 install.template.bat 的 `Compute-PayloadSha` 与 `Get-DepsKey`

## 上传文件访问签名（上传签名访问）

- `/uploads/*` 无鉴权静态托管已移除，改为 HMAC 签名访问（`utils/uploadSign.js`）：URL 需带 `?expires=&sig=`，无签名/篡改/过期一律 403
- 签名出口：REST 响应经 `server.js` 的 `res.json` 包装中间件自动签名；WS 出口在 `utils/message.js` broadcast 与 `websocket/push.js` 签名；`signUploadUrlsDeep` 深度遍历只改 `/uploads/` 字符串，已签名 URL 跳过
- 消息库中存储的 URL 可能带签名 query，`utils/files.js` 提取文件名时按 `split('?')[0]` 剥离
- 新增配置：`uploadUrlExpiresSec`（默认 604800=7 天）、`uploadSecret`（留空自动生成持久化 `data/.upload-secret`）
- 修改签名逻辑时保持 `signUploadPath`/`verifyUploadSig` 双向一致（HMAC-SHA256 于 `url.expires`，恒定时间比较）

## 前端样式约定（美术优化）

- 全局样式统一在 `frontend/src/style.css`：基础层（CJK 字体栈、`::selection`、`:focus-visible` 焦点环、滚动条、tap-highlight）、组件层（关键帧 `fade-in-up`/`scale-in`/`message-in`/`fade-in`/`orb-drift` + `.animate-*` 工具类、auth 页 `.auth-bg`/`.auth-card`/`.auth-input-wrap`/`.btn-gradient`、弹窗/菜单动画、`.sidebar-item::before` 指示条、`.message-row` 动画、移动端按压反馈）
- 登录/注册页用 `.auth-bg`（氛围光晕）+ `.auth-card`（描边/阴影）+ `.btn-gradient`（渐变按钮）+ `.animate-fade-in-up`（交错进入动画）
- `prefers-reduced-motion: reduce` 全局关闭动画；scrollbar 规则已从 index.html 迁入 style.css（index.html 仅留 FOUC 背景）
- **Tailwind 3.4 陷阱**：`@layer components` 中未被任何模板引用的自定义类会被构建时移除——新样式类必须先在模板中使用，`check-art.mjs`（`node frontend/scripts/check-art.mjs`）断言关键规则存在
- 前端改动后跑 `npm run build` + `node frontend/scripts/check-art.mjs` 验证

## 项目清档

主菜单「项目清档」会删除 db.json、uploads、server.pid，需输入 YES 确认；服务运行中会先停止。重启服务后自动重建空数据。备份数据 = 复制整个 data 目录。清档同时停止运行中的隧道并删除隧道配置（cloudflared/ 的 settings.json、config.yml、.cloudflared.pid；sakurafrp/ 的 settings.json、frpc.ini、.sakurafrp.pid、frpc.log），程序本体（exe）保留。

## 当前状态（上次会话结束时）

- 版本 v1.0.4（启动器自动更新，发布准备中）
- 启动器自更新：`Invoke-SelfUpdate`（deploy/install.template.bat）在 main 流程 Resolve-InstallRoot 后调用，三线路（GitHub/ghproxy.net/gh-proxy.com）下载 latest bat → `Read-BatVersion` 读 APP_VERSION → `Compare-Version` 比较 → 确认后 `Copy-BatPreferences` 保留偏好块 → 独立延迟 PS 进程（UTF-8 BOM，Move-Item -LiteralPath）退出后替换 `$BatFile`
- 约束：bat 替换必须在 cmd 读完 EOF 后由独立进程做（避开 Set-BatPreferenceSafe 等长写入冲突）；自更新代码 PS 块不含 %/!；demo 版本（带 - 后缀）跳过自更新
- 语音：WebRTC mesh + perfect negotiation（userId 大小定 polite/impolite）；ICE pending 缓存；iceServers 含 STUN + 公共 TURN（自建 coturn 见 config.json 注释）

## 修改约定

1. 修改 start.js 后必须 `node --check start.js` 验证语法（易错点：await 只能在 async 函数内）
2. 改 bat 后验证纯 ASCII
3. UI 改动保持现有风格（header/item/dangerItem/dim 体系）
4. 新配置项走 config.json → config/index.js defaults → 使用处
5. 前端改动后跑 `npm run build` 验证
6. 修改部署脚本后用管道喂输入测试菜单流程（如 `"2" | node start.js`）
7. 文案/文档避免修饰性内容：标题不加装饰 emoji（✅/❌ 仅用于功能对比表）、不用营销式措辞（"极致/沉浸式体验/更好的视觉体验"等），直接平实描述；功能性的 emoji 列表（如聊天气泡表情选择器）除外
