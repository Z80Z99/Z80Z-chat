# Changelog

## Z80Z-chat v1.0.1（2026-08-13）

安装器 Node.js 下载链路全面修复。

### 修复

- **文件名拼接缺 v**：`node-v22.23.2-win-x64.zip` 拼成 `node-22.23.2-...`，导致所有线路下载 404（下载失败的真正根因）
- **版本号双 v**：index.json 的 version 带 v 前缀（v22.23.2），URL 拼接产生 `/vv22.23.2/` 404
- **测速目标无效**：测 `/v22/SHASUMS256.txt`（不存在）导致全线路误判失败，改回 `/index.json`
- **WebClient.Timeout 属性不存在**：设置抛异常导致版本解析静默失败

### 改进

- 分块断点续传下载（4MB/块 + Range），大文件网络波动只重传小块，不从头再来
- 下载失败自动回退更稳定 LTS 主版本（22 → 20 → 18）
- 绕过系统代理（v2ray/Clash 系统代理不再干扰）+ 显式 TLS 1.2 + 120s 超时
- 失败写 `download-error.log` 诊断日志（含 URL/offset/异常状态），界面显示日志路径

## Z80Z-chat v1.0.0（2026-08-05）

项目更名为 Z80Z-chat，版本号重置为 1.0.0（品牌迭代新起点，此前 NodeChat 时代的版本历史已清除）。

- 品牌/包名/文档/配置从 NodeChat 全面更名（含外层安装器 `Z80Z-chat.bat`、防火墙规则名、systemd 服务文件）
- 完整功能：文字频道实时聊天、WebRTC 语音/投屏、服务器/角色权限、邀请/好友、Cloudflare Tunnel / SakuraFRP 公网访问、智能快速更新
