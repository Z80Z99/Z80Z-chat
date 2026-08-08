# Z80Z-chat 故障排查指南

## 1. 服务无法启动

**症状**：双击 start.bat 后立即闪退 / systemd 显示 failed / 无端口监听。

**排查步骤**：

```bash
# Linux：查看失败原因
journalctl -u z80z-chat -n 50

# Windows：直接前台运行看错误
node server.js
```

**常见原因与处理**：

| 原因 | 处理 |
|------|------|
| 端口被占用 | 见下方「端口占用排查」 |
| `config.json` 语法错误 | 报错会提示"配置文件解析失败"，修复引号/逗号/注释，或直接删除文件（重启自动重建默认配置） |
| `dist/` 不存在（未构建） | 执行 `npm run build`；`/api/version` 返回 `{"version":0}` 也说明未构建 |
| 数据目录不可写（Linux 权限） | `chown -R z80z-chat:z80z-chat data logs && chmod 700 data logs` |
| node 版本过旧 | 要求 Node 18+（建议 20+/22 LTS） |

**日志定位**：启动成功后查看 `logs/app.log` 中的"服务启动成功"记录；异常记录在 `logs/error.log`。

## 2. 端口占用

**症状**：`服务启动失败或超时` / `EADDRINUSE`。

**排查**：

```bash
# Windows
netstat -ano -p tcp | findstr "LISTENING" | findstr ":3000 "
taskkill /F /PID <pid>

# Linux
ss -ltnp | grep 3000
sudo kill -9 <pid>          # 或 systemctl stop 占用该端口的服务
```

**说明**：start.js 主菜单会检测端口并自动清理旧进程（状态灯反映真实进程）；若端口被非 Z80Z-chat 进程占用会显示「端口冲突」黄灯。修改端口：编辑 `config.json` 的 `port` 后重启（或设置 `PORT` 环境变量）。

## 3. 日志查看方法

| 日志 | 位置 | 内容 |
|------|------|------|
| 应用日志 | `logs/app.log` | `[时间] [INFO/WARN] 消息`：启动/关闭/上传失败等 |
| 错误日志 | `logs/error.log` | `[时间] [ERROR] 消息`：请求异常、DB 写入失败、未捕获异常 |
| systemd 日志 | `journalctl -u z80z-chat -f` | 进程级输出 |

日志格式：`[ISO时间] [级别] [消息]`。日志目录可通过 `LOG_DIR` 环境变量修改。写入失败不影响服务运行（静默降级）。

## 4. db.json 损坏恢复

**症状**：启动报"数据库文件解析失败"、API 返回 500、数据丢失。

**恢复流程**：

```bash
# 1. 停止服务（重要）
# 2. 查看可用备份
node scripts/restore.js          # 交互式：列出 → 选择 → 自动保全现场 → 原子恢复
# 或手动：
cp data/backups/db-xxx.json data/db.json
# 3. 启动服务验证
```

**无备份时的处置**：
- 把损坏的 `db.json` 移走（`mv data/db.json data/db.json.corrupt-$(date +%s)`），启动后自动重建空库（数据不可恢复）
- 检查 `data/db.json.tmp` 残留：服务启动会自动清理（原子写入机制保证 db.json 要么完整要么被完整替换，正常情况不会损坏）

**预防**：`npm run backup` 定期备份；写入已为原子操作（临时文件 + rename）。

## 5. 上传文件异常

| 症状 | 原因 | 处理 |
|------|------|------|
| 上传返回「不支持的文件类型」 | 扩展名不在白名单 | `config.json` 的 `allowedUploadTypes` 追加扩展名（竖线分隔）后重启 |
| 上传报「文件过大」 | 超过 `maxUploadSizeMB` | 调整配置后重启 |
| 图片/附件加载 404 | 文件被清理（消息删除后无引用附件自动删除） | 属预期行为；重新上传 |
| `uploads/` 目录存在孤儿文件 | 历史遗留或异常中断 | 附件已实现删除时清理；孤儿文件可手动删除（未被任何消息引用） |
| Linux 上传失败（EACCES） | 目录权限不足 | `chown z80z-chat:z80z-chat data/uploads && chmod 700 data/uploads` |

## 6. WebSocket 连接失败

**症状**：消息/语音不实时、登录后在线状态不更新、浏览器控制台 `WebSocket connection failed`。

**排查顺序**：

1. **确认服务运行**：访问 `http://localhost:3000/api/version` 返回 200
2. **确认路径**：WS 地址为 `ws://<host>:<port>/ws`（`config.json` 的 `wsPath`，一般无需修改）
3. **反向代理时检查 Upgrade 头**：nginx 必须配置
   ```nginx
   location /ws {
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
   }
   ```
4. **HTTPS 环境**：页面必须通过 `https://` 访问（前端自动选 `wss://`）；证书无效会导致 WS 拒绝连接
5. **Cloudflare Tunnel**：确认隧道未禁用 WebSocket
6. **token 过期**：会话有效期 30 天，过期后 WS 以 4001 关闭，前端会引导重新登录
7. **权限被拒**：join-channel 返回 `{type:'error'}`（非成员/无 viewChannel）属正常保护；语音 join 需 viewChannel + 语音频道

**在线状态异常**：服务每 30 秒广播在线用户；若用户"假在线"，是 WS 断开未正常上报（断网场景），重连后自动修正。

## 7. 其他常见问题

| 问题 | 处理 |
|------|------|
| 忘记管理员账号 | 数据库中用户名可查：`data/db.json` 的 `users` 字段（密码为哈希，不可逆，需重置账号） |
| 服务"运行中"但页面 500 | 查看 `logs/error.log` 最近 ERROR 记录定位 |
| 想彻底重置 | start.js 主菜单「项目清档」（删除全部数据，需输入 YES 确认） |
