# Z80Z-chat

仿 Discord 风格的社区聊天系统。聊天服务与数据可在本地运行，使用 JSON 文件存储，无需外部数据库。跨网络语音和投屏可按需配置 STUN/TURN，公网访问可使用反向代理或隧道。

## 功能

- 聊天：实时消息、图片和文件预览、回复、编辑、删除、按频道保存草稿；发送未确认时可沿用原提交重试，避免重复消息。
- 阅读与找回：持久化未读、回到最新、原消息定位、六种表情回应、置顶、按正文 / 文件名 / 发送者搜索。
- 提醒：成员提及、受权限控制的全体提及、应用内通知；每个频道可选择所有消息、仅提及或静音。
- 社区：服务器 / 频道 / 分类与角色权限管理、邀请链接、好友；欢迎介绍、规则、推荐频道、头像和横幅裁切，以及由管理者发布的公告频道。
- 语音：WebRTC 点对点通话、输入和输出设备选择、麦克风与扬声器测试、总音量和成员音量、开放麦克风或按键发言，手机可按住说话。
- 投屏：画质与帧率选择、共享来源切换、指定成员画面、影院模式、暂停与全屏，以及按成员查看连接诊断。
- 桌面与手机布局、键盘焦点、消息长按操作、减少动画偏好；自动重连与账号、房间隔离。

提醒目前通过应用内面板提供。实体设备、手机软键盘、蓝牙切换和公网语音 / 投屏仍需独立验收。

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | Vue 3 + Pinia + Vue Router + Tailwind CSS + TypeScript |
| 后端 | Node.js + Express（ESM） |
| 实时 | WebSocket（消息推送 / 语音信令） |
| 语音/投屏 | WebRTC 点对点 |
| 存储 | 本地 JSON 文件（`data/db.json`）+ 上传目录 |

## 快速启动

要求：Node.js 18+，并使用随源码提供的 `package-lock.json`。

```bash
npm ci --include=dev     # 按锁文件安装运行与构建依赖
npm run check:frontend   # Vue 模板 / 配置类型检查、构建及界面规则检查
node server.js           # 使用已构建的 dist/ 启动
```

启动后访问 `http://localhost:配置端口号`，注册账号即可创建服务器。

开发时使用 `npm run dev`。`npm start` 会重新构建前端，需要保留开发依赖；仅运行已构建版本时使用 `node server.js`。

## Windows 使用方式

双击 `start.bat` 打开交互式管理菜单：

- 启动 / 重启 / 停止服务
- 转入后台运行（关闭窗口服务继续）
- 查看配置 / 编辑配置（记事本）
- 项目说明 / 项目清档
- 服务状态实时检测（运行中 / 端口冲突 / 未运行）

防火墙规则自动配置（首次启动弹 UAC 授权），局域网设备可直接访问。

### 单文件部署（Z80Z-chat.bat）

本仓库是完整源码；单文件安装器 `Z80Z-chat.bat` 是构建产物（内含引导层 + 源码 zip）：

```bash
npm run build:single    # 生成 Z80Z-chat.bat（版本号取自 package.json）
```

生成的 bat 双击后选择安装目录，按需下载 Node.js，再执行 `npm ci --include=dev` 和 `npm run check:frontend`，之后作为交互式启动器使用。

完整升级先在临时目录安装、检查并构建，成功后再替换代码；保留现有 `data/`、`logs/` 和 `config.json`，失败保留旧版。只有源码内容和依赖一致、且已有 `dist/` 与 `node_modules/` 时才进入快速升级，沿用这两个目录。升级前仍应备份完整数据目录。

当前 v1.0.9 已完成本地构建及隔离安装、升级验收，尚未发布 GitHub Release；已有真实安装目录保持原样。具体流程见 [单文件部署说明](docs/SINGLE-FILE.md)。

## Linux 部署

```bash
# 完整部署指南见 docs/DEPLOYMENT.md
sudo cp deploy/z80z-chat.service /etc/systemd/system/
sudo systemctl enable --now z80z-chat
```

包含 systemd 服务模板（独立用户、自动重启、UMask=0077）、nginx 反向代理与 HTTPS/WSS 配置、Cloudflare Tunnel 兼容说明。

## 测试

```bash
npm test                 # node:test 回归测试
npm run check:frontend   # 完整前端验收
```

测试使用随机端口与临时目录隔离运行数据，当前完整回归使用 Node.js 24；安装器事务回归仅在 Windows PowerShell 执行。前端类型回归使用项目安装的 Vue 检查工具。架构与覆盖范围见 [测试说明](docs/TESTING.md)。

## 备份与恢复

```bash
npm run backup              # 备份 data/db.json → data/backups/
node scripts/restore.js     # 交互式恢复（恢复前自动保全当前数据）
```

> 完整备份 = `data/` 整个目录（db.json + uploads + backups）。详细说明见 `docs/BACKUP.md`。

## 目录结构

```
z80z-chat/
├── start.bat / start.js    # Windows 交互式管理
├── package-lock.json      # 安装与构建依赖锁文件
├── server.js               # Express 服务入口
├── config.json             # 部署配置（含中文注释）
├── config/index.js         # 配置加载（支持 PORT/HOST/DATA_DIR 环境变量）
├── models/db.js            # JSON 数据库（原子写入）
├── routes/                 # REST API
├── websocket/              # WS 服务（消息推送 + 语音信令）
├── utils/                  # 权限 / 消息 / 文件 / 日志工具
├── scripts/                # backup.js / restore.js
├── deploy/                 # systemd 服务模板
├── docs/                   # 部署 / 备份 / 测试 / 故障排查文档
├── test/                   # 自动化回归测试
└── frontend/               # Vue 3 前端
```

## 文档

| 文档 | 内容 |
|------|------|
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Linux 部署、systemd、nginx 反代、HTTPS/WSS |
| [docs/SINGLE-FILE.md](docs/SINGLE-FILE.md) | 单文件部署（Z80Z-chat.bat）安装/更新/备份 |
| [docs/BACKUP.md](docs/BACKUP.md) | 备份恢复流程与数据迁移 |
| [docs/TESTING.md](docs/TESTING.md) | 测试架构与覆盖范围 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 故障排查指南 |
| [CHANGELOG.md](CHANGELOG.md) | 版本发布说明 |

## License

本地自用项目，无外部依赖承诺。
