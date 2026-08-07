# NodeChat Linux 部署指南

本文档面向 Linux 服务器长期运行部署。Windows 部署请使用 `start.bat`（不受本文档影响）。

## 1. 安装 Node.js

要求 Node.js **18+**（项目使用 ESM 与 `node:test`，建议 20+ / 22 LTS）。

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
sudo useradd --system --home /opt/nodechat --shell /usr/sbin/nologin nodechat
```

## 3. 部署项目目录

```bash
sudo mkdir -p /opt/nodechat
sudo cp -r /path/to/nodechat/. /opt/nodechat/   # 复制项目（不含 node_modules）
sudo chown -R nodechat:nodechat /opt/nodechat
```

数据与日志目录（权限 700，`UMask` 只影响新文件，已存在目录需手动设置）：

```bash
sudo mkdir -p /opt/nodechat/data /opt/nodechat/logs
sudo chown nodechat:nodechat /opt/nodechat/data /opt/nodechat/logs
sudo chmod 700 /opt/nodechat/data /opt/nodechat/logs
```

## 4. 安装依赖并构建前端

```bash
cd /opt/nodechat
sudo -u nodechat npm install --omit=dev   # 仅生产依赖（bcryptjs/multer/ws 等）
sudo -u nodechat npm run build            # 产出 dist/
```

构建产物为静态文件（`dist/`），由 server.js 托管，无需额外 Web 服务器。

## 5. systemd 管理服务

```bash
sudo cp deploy/nodechat.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nodechat       # 开机自启 + 立即启动
```

服务模板已包含：独立用户、`Restart=on-failure`、`UMask=0077`、安全加固、`PORT/DATA_DIR/LOG_DIR` 环境变量。如需修改环境变量，编辑模板或改用 `EnvironmentFile`。

## 6. 查看服务状态与日志

```bash
systemctl status nodechat        # 运行状态 / 最近日志
sudo systemctl restart nodechat  # 重启
sudo systemctl stop nodechat     # 停止

journalctl -u nodechat -f        # 实时日志（journald）
# 应用自身日志（结构化）：
tail -f /opt/nodechat/logs/app.log
tail -f /opt/nodechat/logs/error.log
```

## 7. 更新版本流程

```bash
cd /opt/nodechat
sudo -u nodechat npm run backup              # 1. 先备份当前数据
sudo systemctl stop nodechat                 # 2. 停止服务
sudo -u nodechat cp -r . /opt/nodechat.old   # 3.（可选）整目录回退副本
# 4. 覆盖代码（保留 data/ 与 logs/！）
sudo rsync -a --exclude node_modules --exclude data --exclude logs /新版本/ /opt/nodechat/
sudo chown -R nodechat:nodechat /opt/nodechat
sudo -u nodechat npm install --omit=dev
sudo -u nodechat npm run build
sudo systemctl start nodechat                # 5. 启动并验证
systemctl status nodechat
```

> 更新时**绝不删除 `data/`**（数据库与上传文件）。如版本含数据库结构变化，先备份再更新。

## 8. nginx 反向代理

NodeChat 无内置 TLS，公网部署建议用 nginx 终止 HTTPS 并转发：

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

- NodeChat 的 API 为相对路径、WS 协议自适应，**原生兼容 Cloudflare Tunnel**，无需代码修改
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
