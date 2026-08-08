# 单文件部署模式（Z80Z-chat.bat）

Z80Z-chat 可打包为**单个文件**（`Z80Z-chat.bat`，约 300KB），双击即可完成
Node.js 下载、依赖安装、前端构建、启动服务全流程，适合分发给非技术用户。

## 运行结构

建议将 `Z80Z-chat.bat` 放入一个**空白文件夹**，首次双击完成安装后目录结构如下：

```
部署文件夹/
├── Z80Z-chat.bat        # 单文件安装程序（以后双击 = 管理菜单）
├── nodejs/             # 自带的 Node.js 运行时（选择"自动下载"时生成）
├── data-backup/        # 外层数据备份目录（更新时自动备份）
└── z80z-chat/           # 项目本体（start.js / config.json / data/ …）
```

- 项目文件夹名可在首次安装时指定（默认 `z80z-chat`）
- 卸载 = 直接删除整个部署文件夹
- 再次双击 `Z80Z-chat.bat` 会自动发现已安装项目并进入管理菜单

## 安装流程（首次双击）

1. 选择 Node.js 来源：
   - **使用系统 Node.js** —— 检测到 PATH 中已有 Node ≥ 18 时提供
   - **自动下载自带 nodejs/** —— 约 25MB，环境隔离（推荐分发给无 Node 的用户）
   - 手动下载（提供教程）
2. 选择网络线路（自动测速，Node.js 下载与 npm 安装共用的镜像线路）
3. 设置端口（留空自动选择随机可用端口 10000-60000）
4. 自动完成：释放项目 → npm install → 前端构建

## 配置承载（v1.0.8+）

所有部署配置统一存放在项目内 **`config.json`**（带中文注释，记事本可编辑），
**不再使用外层 `.install-config.json`**（旧版残留会在安装/更新时自动吸收并删除）。

| 字段 | 作用 |
|------|------|
| `backupKeep` | 自动清理旧备份时保留的份数（默认 3） |
| `nodeVersion` | 自动下载 Node.js 使用的主版本（默认 22，Win8 及以下自动回退 18） |
| `nodeMirror` | Node.js 下载镜像（安装时选择线路后自动写入） |
| `npmRegistry` | npm 镜像源（安装时选择线路后自动写入） |
| `port` / `host` 等 | 服务监听配置（原有字段不变） |

## 更新流程

- 将新版 `Z80Z-chat.bat` 覆盖部署文件夹中的旧版，再双击运行
- 检测到版本不同会询问是否更新：停止服务 → 备份数据（data-backup/）→ 重建项目 → 同步依赖 → 重新构建
- 更新**保留**：`data/`、`logs/`、`node_modules/`、`config.json`（用户端口/镜像/备份保留设置不丢失）

## 备份管理

- 主菜单「备份管理」：立即备份 / 查看 / 恢复 / 清理，备份存于外层 `data-backup/`
- 更新流程自动备份，保留份数由 `config.json` 的 `backupKeep` 控制

## 公网访问（隧道管理）

- 无公网 IP 也能对外访问：主菜单「隧道管理」→ 选择服务（Cloudflare Tunnel / SakuraFRP）
- **Cloudflare Tunnel**：`https://chat.z80z99.cn`（需将域名 NS 接入 Cloudflare），cloudflared 按需下载到外层 `cloudflared/` 目录（下载前测速选择线路）
- **SakuraFRP（国内低延迟）**：需 natfrp.com 账号（免费 2 隧道 / 10Mbps / 5GiB 每月），frpc 下载链接从面板「软件下载」复制粘贴，隧道在面板创建（本地 IP 127.0.0.1，端口 = Z80Z-chat 端口），连接方式支持交互（frpc TUI）与命令行（`-f 密钥:隧道ID`）两种
- 两者均为后台运行 + PID 记录，互不影响，与 Z80Z-chat 服务独立

## 智能快速更新

- 更新时自动比对内容指纹：仅启动器（start.js/引导层）变化时跳过备份与 npm install/build，秒完成更新
- 源码/依赖变化时自动走完整更新（备份 → 重建 → 安装依赖 → 构建）

## 兼容性

- Windows 7+（PowerShell 2.0+）
- Windows 8.1 及以下自动使用 Node 18 LTS（Node 20+ 官方要求 Win10+）
- 首次部署若选择「使用系统 Node.js」，之后运行会自动沿用（无需持久化记录）

## 常见问题

- **杀毒软件报毒/拦截**：单文件 bat 内含自解压逻辑，部分杀软（尤其 360/火绒）
  会误报。可加信任白名单，或手动方式运行（见下）。
- **下载缓慢**：换线路（安装时测速选择，或编辑 `config.json` 的镜像字段后重跑更新）。
- **UAC 弹窗**：启动服务时若开启防火墙配置会请求管理员授权，拒绝仅警告不中断。
- **手动方式**：不用单文件也可直接 `node start.js` 管理（需自行安装 Node.js）。

## 构建

```bash
npm run build:single    # 或 node scripts/build-single.js
```

- 输出：项目根目录 `Z80Z-chat.bat`（版本号取自 package.json）
- 打包内容：引导层（部署/install.template.bat）+ start.js + 项目源码 zip
- 排除：node_modules / dist / data / logs / start.js / start.bat / package-lock.json / 构建产物自身
