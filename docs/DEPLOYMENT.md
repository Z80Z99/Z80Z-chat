# Z80Z-chat Linux 部署指南

本文档面向 Linux 服务器长期运行部署。Windows 部署请使用 `start.bat`（不受本文档影响）。

v1.0.9 已完成本地构建及隔离安装、升级验收，尚未发布 GitHub Release，已有真实安装副本保持原样。Windows 单文件安装器的安装与事务升级见 [单文件部署说明](SINGLE-FILE.md)。实体设备和公网语音 / 投屏仍待独立验收。

## 1. 安装 Node.js

要求 Node.js **18+**（项目使用 ESM 与 `node:test`）。

```bash
# Ubuntu/Debian（NodeSource 方式）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 或使用 nvm（多版本管理）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 22
nvm use 22

node -v   # 验证
npm -v
```

## 2. 创建运行用户

使用独立低权限用户运行服务，禁止 root：

```bash
sudo useradd --system --home /opt/z80z-chat --shell /usr/sbin/nologin z80z-chat
```

## 3. 部署项目目录

```bash
sudo mkdir -p /opt/z80z-chat
sudo cp -r /path/to/z80z-chat/. /opt/z80z-chat/   # 从干净发布源码目录复制项目
sudo chown -R z80z-chat:z80z-chat /opt/z80z-chat
```

复制前先准备不含 `node_modules/`、运行数据、日志和部署者凭据的发布源码目录；上述 `cp` 命令本身不执行排除。

数据与日志目录（权限 700，`UMask` 只影响新文件，已存在目录需手动设置）：

```bash
sudo mkdir -p /opt/z80z-chat/data /opt/z80z-chat/logs
sudo chown z80z-chat:z80z-chat /opt/z80z-chat/data /opt/z80z-chat/logs
sudo chmod 700 /opt/z80z-chat/data /opt/z80z-chat/logs
```

## 4. 安装依赖并构建前端

```bash
cd /opt/z80z-chat
sudo -u z80z-chat npm ci --include=dev     # 按 package-lock.json 安装构建及运行依赖
sudo -u z80z-chat npm run check:frontend   # 类型、构建与界面规则检查，产出 dist/
```

构建产物为静态文件（`dist/`），由 server.js 托管，无需额外 Web 服务器。

源码部署须包含 `package-lock.json`。Vite、Vue 和类型检查工具位于开发依赖中，构建前不能省略它们。构建完成后可按需执行 `sudo -u z80z-chat npm prune --omit=dev`，仅保留后端运行依赖；下次更新时先重新执行上述安装步骤。

若部署的是已经构建并包含 `dist/` 的完整发布目录，可直接执行 `sudo -u z80z-chat npm ci --omit=dev`。手动启动使用 `sudo -u z80z-chat node server.js`；`npm start` 会重新构建，需要开发依赖。systemd 服务使用 `node server.js` 启动。

## 5. systemd 管理服务

```bash
sudo cp deploy/z80z-chat.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now z80z-chat       # 开机自启 + 立即启动
```

服务模板已包含：独立用户、`Restart=on-failure`、`UMask=0077`、安全加固、`PORT/DATA_DIR/LOG_DIR` 环境变量。如需修改环境变量，编辑模板或改用 `EnvironmentFile`。

## 6. 查看服务状态与日志

```bash
systemctl status z80z-chat        # 运行状态 / 最近日志
sudo systemctl restart z80z-chat  # 重启
sudo systemctl stop z80z-chat     # 停止

journalctl -u z80z-chat -f        # 实时日志（journald）
# 应用自身日志（结构化）：
tail -f /opt/z80z-chat/logs/app.log
tail -f /opt/z80z-chat/logs/error.log
```

## 7. 更新版本流程

先在独立目录安装和验收新版，再停止服务换目录。以下以 v1.0.9 和默认 `data/`、`logs/` 为例；暂存和旧版目录须尚不存在，避免混入其他版本。使用自定义 `DATA_DIR` / `LOG_DIR` 时，按实际路径备份和保留数据，不要覆盖外部数据目录。Linux 的目录切换与回退由管理员执行，单文件安装器则由升级脚本管理事务。

```bash
set -e
releaseDir=/opt/z80z-chat-next-1.0.9
previousDir=/opt/z80z-chat-before-1.0.9
test ! -e "$releaseDir"
test ! -e "$previousDir"
sudo mkdir "$releaseDir"
sudo rsync -a --exclude node_modules --exclude dist --exclude data --exclude logs /新版本/ "$releaseDir/"
sudo cp /opt/z80z-chat/config.json "$releaseDir/config.json"
sudo chown -R z80z-chat:z80z-chat "$releaseDir"
cd "$releaseDir"
sudo -u z80z-chat npm ci --include=dev
sudo -u z80z-chat npm run check:frontend
# 开发验收使用 Node.js 24 时另跑：sudo -u z80z-chat npm test
# 可选：sudo -u z80z-chat npm prune --omit=dev
```

上述命令任一步失败就停止，当前服务与安装目录保持原样。验收成功后，备份、停服，再复制完整运行数据和日志；数据复制在停服后进行。

```bash
set -e
releaseDir=/opt/z80z-chat-next-1.0.9
previousDir=/opt/z80z-chat-before-1.0.9
cd /opt/z80z-chat
sudo -u z80z-chat npm run backup
sudo systemctl stop z80z-chat
sudo cp -a /opt/z80z-chat/data "$releaseDir/data"
sudo cp -a /opt/z80z-chat/logs "$releaseDir/logs"
# 再次复制配置，保留验收期间对运行配置的修改
sudo cp -a /opt/z80z-chat/config.json "$releaseDir/config.json"
sudo mv /opt/z80z-chat "$previousDir"
sudo mv "$releaseDir" /opt/z80z-chat
sudo systemctl start z80z-chat
systemctl status z80z-chat
```

数据复制失败时旧目录仍在原位，可重新启动旧服务。若第二次目录移动失败，先把旧目录移回 `/opt/z80z-chat` 后启动。新版启动后检查日志、登录、历史消息和上传文件；旧目录在确认新版正常前保留。

若新版启动失败且尚未写入新数据，可停止服务，把新版目录移到另一个未占用的诊断目录，再把 `z80z-chat-before-1.0.9` 移回 `/opt/z80z-chat` 并启动。新版投入使用后回退需先备份最新 `data/` 并核对数据兼容性，直接恢复旧目录会丢失升级后的数据。

> 更新时**绝不删除 `data/`**（数据库与上传文件）。完整数据备份还包括上传签名密钥等隐藏文件。如版本含数据库结构变化，先备份再更新。

## 8. nginx 反向代理

Z80Z-chat 无内置 TLS，公网部署建议用 nginx 终止 HTTPS 并转发：

```nginx
server {
    listen 80;
    server_name chat.example.com;

    # WebSocket 升级头（关键）
    location /ws {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

前端 API 使用相对路径（`/api`、`/uploads`），WS 地址按当前页面协议自动选择 `ws://` 或 `wss://`，因此**无需修改任何前端代码**。

## 9. HTTPS / WSS

方式一：nginx + certbot（推荐）

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d chat.example.com   # 自动签发证书并改写配置
sudo systemctl reload nginx
```

方式二：Caddy（自动 HTTPS，配置最简）

```
chat.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

HTTPS 生效后，浏览器访问 `https://`，前端自动使用 `wss://`，WebSocket 全链路加密，无需额外配置。

## 10. Cloudflare Tunnel 部署注意事项

- Z80Z-chat 的 API 为相对路径、WS 协议自适应，**原生兼容 Cloudflare Tunnel**，无需代码修改
- Tunnel 配置（`cloudflared`）默认支持 WebSocket；如遇 WS 失败，确认 Tunnel 配置未禁用 WS 流（无需 `--no-ws`）
- 若 Tunnel 后仍希望隐藏真实端口，`cloudflared tunnel --url http://localhost:3000` 即可
- 注意：`corsOrigins` 默认 `*`（反射来源），经 Tunnel 同域访问无跨域问题

## 11. 环境变量参考

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | config.json 的 port（3000） | 监听端口 |
| `HOST` | config.json 的 host（0.0.0.0） | 监听地址 |
| `DATA_DIR` | config.json 的 dataDir（data） | 数据根目录（db.json / uploads / backups），支持绝对路径 |
| `LOG_DIR` | 项目 `logs/` | 日志目录（app.log / error.log） |

其余配置（上传大小/类型、CORS、WS 路径、ICE 服务器、站点名）见 `config.json`（含中文注释）。
