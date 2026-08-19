# Changelog

## Z80Z-chat v1.0.5（2026-08-14）

自更新体验修复、无用代码清理、管理菜单增强。

### 修复

- **自更新检查黑屏等待**：检查移入已安装项目分支（首次安装不再联网检查，零等待）；新增 24 小时检查频率缓存（`.last-check` 时间戳）；线路改为镜像优先（ghproxy → gh-proxy → 官方），超时 8s → 5s
- **npm install 残留日志**：安装成功后自动清理 `.npm-out-*.txt`

### 新增

- **前台运行菜单「返回主菜单」**：服务前台运行时选 0，服务转入后台继续运行并回到主菜单

### 清理

- 删除无用文件与代码：demo 工具链（build-demo / demo-bootstrap / demo-start / 模板）、一次性工具（restore-template / test-screen-fullscreen）、未使用函数（buildFrontend / scanOrphanFiles / screen-refresh relay 等）、前端未使用方法与死状态（speakingUsers / screenDebug / isLoggedIn 等）
- server.js 版本号动态读取 package.json（横幅/日志不再硬编码）

## Z80Z-chat v1.0.4（2026-08-14）

启动器（bat）自动更新。

### 新增

- 启动时自动检查 GitHub 最新版（GitHub 官方 + ghproxy.net + gh-proxy.com 三线路，8 秒超时，失败静默），发现新版本弹确认
- 确认更新后下载新 bat、校验完整性、保留偏好块（不再提示更新/上次项目），由独立延迟进程在退出后替换自身，下次双击即新版
- 仅正式版本参与（demo 等带后缀版本跳过）

## Z80Z-chat v1.0.3（2026-08-14）

修复多人语音频道只有部分人能通的问题（跨网络打洞失败 + 信令健壮性）。

### 修复

- **增加 TURN 中继兜底**：`iceServers` 在 Google STUN 之外增加公共免费 TURN（Metered OpenRelay），跨网络（对称 NAT/运营商级 NAT/移动热点）P2P 打洞失败时自动走中继；config.json 附自建 coturn 说明（隧道带不动 TURN，需公网 UDP 端口）
- **服务端房间注册误删**：用户刷新/重连后旧 ws 关闭会误删新 ws 的房间注册，导致该用户信令收发全断。现在删除前校验 ws 同一性，且不再广播虚假离开事件
- **新人主动建连 + glare 处理**：新加入者收到成员列表后主动对未连接成员发起 offer，不再只依赖老成员发 offer；按 userId 大小定 polite/impolite，用 perfect-negotiation 规则收敛双方同时 offer 的冲突
- **ICE candidate 竞态防护**：`setRemoteDescription`/`addIceCandidate` 全程 await + try/catch，远程描述未就绪时到达的 candidate 先缓存、SRD 完成后补加

## Z80Z-chat v1.0.2（2026-08-14）

安装器环境兼容性修复（针对真实用户机器上报的两个安装失败场景）。

### 修复

- **内置 Node.js 未加入 PATH**：npm install 的安装脚本（如 esbuild 的 `node install.js`）经 `cmd /c` 子进程执行，内置 `nodejs/` 目录不在 PATH 中导致 `'node' is not recognized`，依赖安装退出码 1。现在安装与构建前自动把 `nodejs/` 注入会话 PATH
- **bat 所在目录不可写**：bootstrap 提取写 `%~dp0` 失败（只读磁盘/云同步目录锁定/杀软拦截）直接中断安装。现在自动回退 `%TEMP%` 提取；并新增安装位置选择（默认用户目录下 Z80Z-chat 或手动指定），选择记录在 `.z80z-chat-root` 标记文件，下次运行自动沿用
- **chcp 消耗重定向输入**：`chcp 65001` 在 stdin 重定向时会消耗共享输入句柄，导致后续 `Read-Host` 全部读到 EOF（自动化/管道场景）。加 `<nul` 隔离

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
