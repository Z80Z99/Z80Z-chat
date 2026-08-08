# Z80Z-chat 数据备份与恢复

## 1. 数据组成

| 数据 | 位置 | 说明 |
|------|------|------|
| 数据库 | `data/db.json` | 全部账号 / 会话 / 服务器 / 频道 / 消息 / 角色 / 好友 |
| 上传文件 | `data/uploads/` | 消息中的图片 / 附件（文件名 UUID，消息引用其 URL） |
| 备份 | `data/backups/` | 本工具生成的备份快照 |

**db.json 与 uploads 的关系**：消息记录中的 `image`/`file` 字段保存 `/uploads/<文件名>` 引用。**备份 db.json 时，uploads 内的文件不会自动包含**。完整备份 = db.json + uploads 目录一起复制。

## 2. 手动备份

```bash
npm run backup
```

行为：
- 复制 `data/db.json` → `data/backups/db-YYYYMMDD-HHmmssSSS.json`
- 自动创建 `data/backups/`（不存在时）
- 文件名含毫秒级时间戳，多次备份互不覆盖
- 输出备份路径与大小，保留全部历史备份（不自动清理）

**运行中可执行**：备份为只读复制 + 原子写入保证源文件一致性，不影响运行中的服务。备份前如需绝对一致快照，可先停止服务。

## 3. 手动恢复

```bash
node scripts/restore.js
```

流程：
1. 列出 `data/backups/` 全部备份（按时间倒序）
2. 输入编号选择（回车取消）
3. **恢复前自动把当前 db.json 另存为** `data/backups/db-pre-restore-时间戳.json`（保留现场，可回滚）
4. 通过临时文件 + 原子替换恢复（失败不会破坏当前数据库）

**重要：恢复前先停止服务**：

```bash
sudo systemctl stop z80z-chat        # Linux systemd
# 或 Windows start.bat → 停止服务
node scripts/restore.js
sudo systemctl start z80z-chat
```

> 原因：服务在内存中持有数据库快照，运行中恢复会被下一次写入覆盖；同时避免并发读写。

## 4. 备份目录结构

```
data/
├── db.json                       # 当前数据库
├── uploads/                      # 上传文件
└── backups/
    ├── db-20260802-101138378.json          # 普通备份（restore 可选）
    └── db-pre-restore-20260802-101200.json # 恢复前的现场备份（自动生成）
```

## 5. 自动备份建议

- **手动备份为主**：升级 / 清档 / 大操作前执行一次
- 可选：启动时每日首次自动备份（记录"上次备份日期"，同日不重复）
- Linux 环境可用 cron：`0 3 * * * cd /opt/z80z-chat && npm run backup`
- 保留策略建议：定期清理过旧备份（如保留最近 30 份），脚本按文件名时间戳排序即可

## 6. 数据迁移（换机 / 换目录）

方式一：整体迁移（推荐）

```bash
# 旧机器
tar -czf z80z-chat-data.tar.gz data/

# 新机器：解压到新 DATA_DIR 指向的目录
tar -xzf z80z-chat-data.tar.gz -C /opt/z80z-chat/
sudo chown -R z80z-chat:z80z-chat /opt/z80z-chat/data
```

方式二：仅迁移数据库 + 上传文件

1. 复制 `db.json` 与整个 `uploads/` 目录到新环境
2. 通过 `DATA_DIR` 环境变量（或 config.json 的 `dataDir`）指向新目录
3. 启动服务验证

> 提示：`data/backups/` 可一并迁移（含历史快照）；迁移后首次启动请确认文件权限（Linux 700）。
