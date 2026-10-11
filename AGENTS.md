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
- 构建：`npm run build`（前端产物输出到根目录 `dist/`，由 server.js 静态托管）
- 前端验收：`npm run check:frontend`（完整 Vue 模板与 Vite 配置类型检查、构建及界面规则检查）；单独检查类型使用 `npm run typecheck`

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
    ├── components/ScreenShareStage.vue  # 画面选择与影院容器
    ├── components/ScreenShareVideo.vue  # 投屏观看组件
    ├── views/Home.vue # 主界面（使用 ScreenShareStage）
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
  - 保留公开状态、偏好、设备枚举、房间与账号协调；连接、信令、投屏、麦克风、音频播放和统计资源分别委托下面六个控制器，不在 store 中重复实现
  - `utils/voice-session.ts` 定义账号、令牌、房间与版本标记；异步控制器同时核对会话与当前 PeerConnection 身份
  - `utils/voice-diagnostics.ts`：按当前轨道解析统计与选中通路；详细诊断仅在面板打开时解析，未知反馈不用于自动码率升档
  - `screenDebug`（pushScreenDebug）用于诊断
- `utils/voice-peers.ts`：每个 store 实例拥有独立连接、ICE 配置缓存和重试资源；`ensureIceServers()` 单飞获取 `/api/config`，失败回退 STUN，入房前必须 await。重试最多三次，任务核对自身身份，connected 或清理才重置
- `utils/voice-signaling.ts`：协商、礼貌方回退和 ICE 候选绑定具体连接；投屏期间重建使用完整清理。`requestScreenRefresh(userId?)` 通过 ICE 重启及 video transceiver 补偿，目标成员请求去重，迟到回调不能恢复旧房间
- `utils/voice-screen-share.ts`：本地采集、切源、画质和码率适配。保留 H264 > VP8 并排除 VP9；切源提交和每发送轨替换串行，失效操作回滚，停止后迟到替换最终清空。未安装采集轨由控制器持有，离房立即停止；源结束按当前流引用判定，不沿用重连前的旧会话标记
- `utils/voice-microphone.ts`：麦克风采集、处理图、原始与处理轨门控、输入音量、设备结束监听和发送恢复。每个 sender 的替换串行，恢复复用 recvonly/null sender；后续采集失败也需完成已有活轨的安装。换房与重连仅复用活音频流，结束流重新采集，失败保持仅收听
- `utils/voice-audio-playback.ts`：远端播放元素、自动播放重试、输出设备队列、分析器和本地提示音；输出音量为成员音量乘全局音量。队列执行前核对元素属主、会话与当前选择，清理先移除属主；本地提示音不连接麦克风发送图
- `utils/voice-statistics.ts`：RTC/电平计时器、统计单飞和详细诊断基线。停轮询使已排队回调失效，不能清掉未完成 getStats 的单飞；旧会话/连接结果不能重建状态。输入和输出分析缓冲由各媒体控制器复用
- 控制器通过明确类型的 refs 和媒体回调接线，不导入 store 或持有整个 store；初始化必须在房间事件/会话监听生效前完成。浏览器选择器及媒体 Promise 无法强制取消，返回后必须核对属主并清理
- `ScreenShareVideo.vue`：状态机（waiting/loading/playing/paused/blocked/stalled/ended/error），未选中或页面隐藏时暂停呈现，不停止输入轨；手动暂停跨画面切换保留。静态或黑色的已解码内容不视为无数据，远端确实无数据时可触发目标刷新；控制条仅保留 播放/暂停 + 全屏（用户要求精简）
- `ScreenShareStage.vue`：按成员 ID 选择画面，影院保留通话控制及按住发言；`VoiceDiagnostics.vue` 负责按需诊断面板与焦点约束
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
- 单份内存快照生成 ZIP、内嵌 start.js、版本号和内容指纹；源码 ZIP 包含 start.js 与 package-lock.json，使用 Node deflate 压缩及 UTF-8 文件名，不依赖 Compress-Archive。打包排除运行目录、私有环境/隧道/安装缓存与链接，发布配置不得含私有签名密钥或 ICE 凭据。
- 安装端判定（install.template.bat `Update()`）：解压 zip 到临时目录 → `Compute-PayloadSha` 与 PAYLOAD_SHA 比较 → 与 `.install-version` 记录的 payloadHash 比较 → `Get-DepsKey`（dependencies+devDependencies，**排除 version**）比较 → node_modules/.bin/vite.cmd 与 dist/index.html 存在
- `Write-Project` 隔离解压并验证内容指纹及两份 start.js 一致，保留配置时跳过默认 config.json；首次安装也写入 payloadHash。
- `Invoke-ProjectUpdate` 完整路径先在临时目录按锁文件安装并执行 check:frontend，成功后停服、备份真实 dataDir（含隐藏文件）再事务替换代码/依赖/构建。快速路径跳过依赖安装、构建与数据备份，保留原 node_modules 和 dist。两者提交失败恢复旧文件；恢复被阻断时保留回退目录。配置、默认及自定义运行目录保持，外部运行路径不移动；公共收尾在 `Finish-Update`。项目内部绝对 dataDir/DATA_DIR/LOG_DIR 阻止自动改名；重命名使用 LiteralPath 和 ErrorAction Stop，失败仍从实际目录进入管理菜单。
- 指纹算法必须与构建端一致：相对路径用 `/`、Ordinal 排序、UTF-8 文件名、内容逐文件 sha256
- 修改内容指纹算法时，必须同步改构建端 `computePayloadSha` 与安装端 `Compute-PayloadSha`。只调整发布条目时保持两端算法不变，并验证实际 ZIP 与指纹一致；安装器回归使用隔离目录，禁止执行用户安装目录或服务的操作。

## 上传文件访问签名（上传签名访问）

- `/uploads/*` 无鉴权静态托管已移除，改为 HMAC 签名访问（`utils/uploadSign.js`）：URL 需带 `?expires=&sig=`，无签名/篡改/过期一律 403
- 签名出口：REST 响应经 `server.js` 的 `res.json` 包装中间件自动签名；WS 出口在 `utils/message.js` broadcast 与 `websocket/push.js` 签名；`signUploadUrlsDeep` 只处理合法本地 `/uploads/` 路径，有效签名保留，过期或无效签名重新生成
- 消息库中存储的 URL 可能带签名 query，`utils/files.js` 提取文件名时按 `split('?')[0]` 剥离
- 新增配置：`uploadUrlExpiresSec`（默认 604800=7 天）、`uploadSecret`（留空自动生成持久化 `data/.upload-secret`）
- 修改签名逻辑时保持 `signUploadPath`/`verifyUploadSig` 双向一致（HMAC-SHA256 于 `url.expires`，恒定时间比较）

## 社区资料与公告频道

- 社区公开资料由 `utils/server-profile.js` 校验与序列化，`banner`、`welcome` 和 `profileRevision` 为旧记录提供响应默认值；更新要求当前成员具有 `manageServer` 权限或为所有者。
- 社区设置携带 `expectedRevision`，冲突返回 409，保留草稿并由用户明确重新加载；旧 API 调用可省略版本。头像恢复默认提交 `avatar: 'default'`，移除横幅提交 `banner: ''`。
- `/api/upload/community/:serverId/:kind` 先鉴权再处理文件，仅允许 PNG/JPEG/WebP；头像为正方形、横幅为 4:1。绑定已有上传文件时也核对尺寸和大小，不能从通用上传接口绕过限制。文件清理须保留其他消息、用户或社区引用。
- `CommunityWelcome.vue` 展示介绍、规则与推荐频道；语音推荐只导航，不自动采集麦克风或加入房间。`CommunityProfileEditor.vue` 与 `CommunityImageCropper.vue` 负责本地裁切、保存时上传、草稿与资源清理；文字按纯文本呈现。
- `Avatar.vue` 显式声明图片 `error` 事件；社区图片错误处理核对当前元素、图片地址及社区身份，旧图片事件不能隐藏新图。父组件负责失败占位，换图或换社区后恢复。
- 消息频道包含 `text` 和 `announcement`，后端与前端均使用各自的 `isMessageChannel`；公告发布及编辑还要求所有者或 `manageMessages`，仍遵守原有查看、发送、禁言和附件权限。普通成员可按原权限阅读、搜索和回应，频道类型创建后不可转换。
- `server-updated`、`channel-created`、`channel-updated`、`channel-deleted` 仅推送到当前有效成员会话，并检查现有服务器级 `viewChannel`；本项目尚无独立频道权限覆盖。前端资料与频道更新统一经 server store 会话、版本和删除记录守卫，异步详情不得直接覆盖当前选择。

## 前端样式约定（美术优化）

- 全局样式统一在 `frontend/src/style.css`：基础层（CJK 字体栈、`::selection`、`:focus-visible` 焦点环、滚动条、tap-highlight）、组件层（关键帧 `fade-in-up`/`scale-in`/`message-in`/`fade-in`/`orb-drift` + `.animate-*` 工具类、auth 页 `.auth-bg`/`.auth-card`/`.auth-input-wrap`/`.btn-gradient`、弹窗/菜单动画、`.sidebar-item::before` 指示条、`.message-row` 动画、移动端按压反馈）
- 登录/注册页用 `.auth-bg`（氛围光晕）+ `.auth-card`（描边/阴影）+ `.btn-gradient`（渐变按钮）+ `.animate-fade-in-up`（交错进入动画）
- `prefers-reduced-motion: reduce` 全局关闭动画；scrollbar 规则已从 index.html 迁入 style.css（index.html 仅留 FOUC 背景）
- **Tailwind 3.4 陷阱**：`@layer components` 中未被任何模板引用的自定义类会被构建时移除——新样式类必须先在模板中使用，`check-art.mjs`（`node frontend/scripts/check-art.mjs`）断言关键规则存在
- 前端改动后跑 `npm run check:frontend`，依次验证完整 Vue 模板及 Vite 配置类型、生产构建和 `check-art.mjs` 界面约定。保持 `strictTemplates`，原生 `data-*` 由明确配置支持；不要恢复屏蔽组件 props/事件类型的宽泛 Vue shim。

## 项目清档

主菜单「项目清档」会删除 db.json、uploads、server.pid，需输入 YES 确认；服务运行中会先停止。重启服务后自动重建空数据。备份数据 = 复制整个 data 目录。清档同时停止运行中的隧道并删除隧道配置（cloudflared/ 的 settings.json、config.yml、.cloudflared.pid；sakurafrp/ 的 settings.json、frpc.ini、.sakurafrp.pid、frpc.log），程序本体（exe）保留。

## 当前状态（上次会话结束时）

- 源码版本 v1.0.9（本地分发准备中），完整回归使用 Node.js 24；真实设备和公网验收尚待进行
- 启动器自更新：`Invoke-SelfUpdate` 仅在已安装项目分支调用（首次安装零等待）；24h 检查频率缓存（`.last-check` 时间戳文件写 bat 同目录，写失败静默）；线路镜像优先；超时 5s
- 前台运行菜单含「0 返回主菜单」（服务转入后台继续运行并返回主菜单）；npm install 成功后清理 `.npm-out-*` 残留
- 语音：WebRTC mesh + perfect negotiation（userId 大小定 polite/impolite）；ICE pending 缓存；iceServers 含 STUN + 公共 TURN（自建 coturn 见 config.json 注释）
- 仓库还有独立分支 friend-easter-egg（朋友恶搞彩蛋，不影响 master，勿合并）

## 修改约定

1. 修改 start.js 后必须 `node --check start.js` 验证语法（易错点：await 只能在 async 函数内）
2. 改 bat 后验证纯 ASCII
3. UI 改动保持现有风格（header/item/dangerItem/dim 体系）
4. 新配置项走 config.json → config/index.js defaults → 使用处
5. 前端改动后跑 `npm run check:frontend` 验证；构建工具位于开发依赖中，源码部署先执行 `npm ci --include=dev`
6. 修改部署脚本后用管道喂输入测试菜单流程（如 `"2" | node start.js`）
7. 文案/文档避免修饰性内容：标题不加装饰 emoji（✅/❌ 仅用于功能对比表）、不用营销式措辞（"极致/沉浸式体验/更好的视觉体验"等），直接平实描述；功能性的 emoji 列表（如聊天气泡表情选择器）除外
