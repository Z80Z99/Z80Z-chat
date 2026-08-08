# Z80Z-chat

仿 Discord 风格的社区聊天系统。100% 本地运行、零外部服务依赖（无数据库、无云服务）。

## 功能

- 文字频道聊天：消息实时推送，支持图片 / 文件上传
- 语音频道：WebRTC 点对点语音，麦克风 / 扬声器 / 音量设置
- 屏幕投屏：画质可选，手机可观看，断流自动修复
- 服务器 / 频道 / 分类管理，角色权限体系
- 邀请链接、好友系统、移动端适配
- 自动刷新与断线重连，语音状态自动恢复

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | Vue 3 + Pinia + Vue Router + Tailwind CSS + TypeScript |
| 后端 | Node.js + Express（ESM） |
| 实时 | WebSocket（消息推送 / 语音信令） |
| 语音/投屏 | WebRTC 点对点 |
| 存储 | 本地 JSON 文件（`data/db.json`）+ 上传目录 |

## 快速启动

要求：Node.js 18+（建议 20+ / 22 LTS）

```bash
npm install        # 安装依赖
npm run build      # 构建前端（输出到 dist/）
npm run start      # 构建并启动
```

启动后访问 `http://localhost:3000`，注册账号即可创建服务器。

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

生成的 bat 可直接分发：双击首次运行完成安装（下载 Node.js → npm install → 构建），之后作为启动器使用，支持智能快速更新。

## Linux 部署

```bash
# 完整部署指南见 docs/DEPLOYMENT.md
sudo cp deploy/z80z-chat.service /etc/systemd/system/
sudo systemctl enable --now z80z-chat
```

包含 systemd 服务模板（独立用户、自动重启、UMask=0077）、nginx 反向代理与 HTTPS/WSS 配置、Cloudflare Tunnel 兼容说明。

## 测试

```bash
npm test           # 81 个用例，node:test 零依赖
```

测试完全隔离（随机端口 + 临时数据目录），不会触碰真实数据。架构与覆盖范围见 `docs/TESTING.md`。

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
├── test/                   # 自动化测试（81 例）
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
