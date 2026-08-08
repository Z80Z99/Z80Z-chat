# Z80Z-chat 自动化测试

## 1. 运行方式

```bash
npm test          # 等价于 node --test（自动发现 test/*.test.js）
```

- 全部用例并行执行，总耗时约 8 秒
- 测试失败时进程退出码非 0，可用于 CI 集成

## 2. 测试架构（node:test）

使用 **Node 原生测试框架**（`node:test` + `node:assert/strict`），**零额外依赖**（无 Jest/Vitest/Supertest）。

```
test/
├── helpers.js           # 测试基础设施
├── auth.test.js         # 认证（9 例）
├── servers.test.js      # 服务器/频道/角色权限（9 例）
├── messages.test.js     # 消息全流程（8 例）
├── websocket.test.js    # WS 认证/join-channel/广播（7 例）
├── upload.test.js       # 上传与附件清理（6 例）
├── roles.test.js        # 角色层级（9 例）
├── ws-sync.test.js      # 消息编辑/删除 WS 同步（3 例）
├── invites.test.js      # 邀请权限/脱敏（6 例）
├── voice.test.js        # 语音权限/信令隔离（6 例）
├── db-atomic.test.js    # 原子写入可靠性（4 例）
├── backup.test.js       # 备份恢复（6 例）
└── logger.test.js       # 日志模块（5 例）
```

共 **79 个用例**。`helpers.js` 提供：服务生命周期（start/stop/restart）、API 请求封装、注册/建服/邀请工具、WS 连接封装、db.json 直读写。

## 3. 测试隔离机制

每个测试文件**完全独立**：

| 维度 | 机制 |
|------|------|
| 端口 | 随机分配（3100~3899），支持并行执行不冲突 |
| 数据目录 | 临时目录（`os.tmpdir()/z80z-chat-test-xxx`），`DATA_DIR` 注入服务进程，结束后自动删除 |
| 日志目录 | `LOG_DIR` 指向临时目录（logger 测试用） |
| 服务进程 | 每个文件 before() 启动独立 `server.js` 子进程，after() 关闭 |

**测试不会触碰你的真实数据**：任何情况下测试都不读写项目 `data/` 目录。

## 4. DATA_DIR / LOG_DIR 的作用

| 环境变量 | 用途 | 测试场景 |
|----------|------|----------|
| `DATA_DIR` | 覆盖数据根目录（db.json/uploads/backups） | 测试隔离 + 篡改 db.json 重启验证（session 过期、权限变更） |
| `LOG_DIR` | 覆盖日志目录 | logger 测试隔离 |

两者均由生产代码原生支持（config/index.js 与 utils/logger.js），测试与服务共用同一套配置机制，**无需测试专用代码路径**。

## 5. 当前覆盖范围

- **认证**：注册/登录/重复名/弱密码/me/无效 token/无 token/session 过期自动清理
- **权限**：服务器/频道/角色 CRUD 的 owner 与成员权限、非成员 403、转让、邀请加入、角色层级（同级/高等级禁止）、mentionEveryone、禁言、sendMessage/viewChannel
- **消息**：发送/空消息/编辑/删除、WS 广播、编辑删除同步（message-updated/deleted）、广播隔离
- **WebSocket**：认证 4001、join-channel 权限（成员/非成员/不存在频道）、语音 join 权限（非成员/文字频道/无 viewChannel）、信令隔离
- **上传**：未登录 401、UUID 命名、扩展名白名单（子串绕过拒绝）、附件引用清理与保留
- **可靠性**：原子写入（写失败旧文件保留）、备份/恢复、日志模块容错

## 6. 编写新测试的约定

1. 每个文件独立 `before(startServer)` / `after(stopServer)`
2. 需篡改数据后重载：`readDB()/writeDB()` + `restartServer()`
3. 断言使用 `node:assert/strict`（`assert.equal`、`assert.match` 等）
4. 不要在主目录创建临时脚本（会被 `node --test` 误识别为 `*-test.mjs`）
