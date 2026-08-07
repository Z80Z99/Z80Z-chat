import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.join(__dirname, '..')

// 隔离日志目录（项目内 .test-data，避免系统 Temp 活动）：必须在 import logger 前设置
const logRoot = path.join(PROJECT_ROOT, '.test-data')
fs.mkdirSync(logRoot, { recursive: true })
const tmpLogDir = fs.mkdtempSync(path.join(logRoot, 'nodechat-log-'))
process.env.LOG_DIR = tmpLogDir

const { logger, getLogDir } = await import('../utils/logger.js')

after(() => {
  try { fs.rmSync(tmpLogDir, { recursive: true, force: true }) } catch {}
  try { fs.rmdirSync(logRoot) } catch {}
})

const appLog = () => fs.readFileSync(path.join(getLogDir(), 'app.log'), 'utf8')
const errorLog = () => fs.readFileSync(path.join(getLogDir(), 'error.log'), 'utf8')

test('日志目录自动创建，info/warn 写入 app.log', () => {
  logger.info('__TEST_INFO_MSG__')
  logger.warn('__TEST_WARN_MSG__')
  const content = appLog()
  assert.ok(content.includes('__TEST_INFO_MSG__'))
  assert.ok(content.includes('__TEST_WARN_MSG__'))
})

test('日志格式为 [时间] [级别] [消息]', () => {
  logger.info('__TEST_FORMAT_MSG__')
  const line = appLog().split('\n').find(l => l.includes('__TEST_FORMAT_MSG__'))
  assert.match(line, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[INFO\] __TEST_FORMAT_MSG__$/)
})

test('控制台输出与文件格式一致（[时间] [级别] 消息）', () => {
  const captured = []
  const orig = { log: console.log, error: console.error, warn: console.warn }
  console.log = (s) => captured.push(['LOG', s])
  console.error = (s) => captured.push(['ERROR', s])
  console.warn = (s) => captured.push(['WARN', s])
  try {
    logger.info('__TEST_CONSOLE_INFO__')
    logger.error('__TEST_CONSOLE_ERR__')
  } finally {
    console.log = orig.log
    console.error = orig.error
    console.warn = orig.warn
  }
  const infoLine = captured.find(([k]) => k === 'LOG')?.[1]
  const errLine = captured.find(([k]) => k === 'ERROR')?.[1]
  assert.ok(infoLine, 'console.log 应被调用')
  assert.ok(errLine, 'console.error 应被调用')
  assert.match(infoLine, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[INFO\] __TEST_CONSOLE_INFO__$/)
  assert.match(errLine, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[ERROR\] __TEST_CONSOLE_ERR__$/)
})

test('error 写入 error.log，不写入 app.log', () => {
  logger.error('__TEST_ERROR_MSG__')
  assert.ok(errorLog().includes('__TEST_ERROR_MSG__'))
  assert.ok(!appLog().includes('__TEST_ERROR_MSG__'))
})

test('日志写入失败不影响调用方（目录被文件占用）', () => {
  // 把日志目录替换为文件 → appendFileSync 失败
  const badDir = path.join(logRoot, 'nodechat-log-bad-' + Date.now())
  fs.writeFileSync(badDir, 'this is a file not a dir')
  const old = getLogDir()
  process.env.LOG_DIR = badDir

  // 不应抛出
  assert.doesNotThrow(() => logger.info('__TEST_FAIL_SAFE__'))
  assert.doesNotThrow(() => logger.error('__TEST_FAIL_SAFE_ERR__'))

  // 恢复
  process.env.LOG_DIR = old
  fs.unlinkSync(badDir)
})

test('logger 异常不会导致测试进程崩溃', () => {
  // 多次调用不抛错即证明进程存活
  for (let i = 0; i < 5; i++) {
    logger.info('__TEST_LOOP_' + i + '__')
    logger.error('__TEST_ERR_' + i + '__')
  }
  assert.ok(appLog().includes('__TEST_LOOP_4__'))
  assert.ok(errorLog().includes('__TEST_ERR_4__'))
})

test('日志超过阈值自动轮转为 .old 文件', () => {
  // 用极小阈值触发轮转（默认 5MB）
  process.env.LOG_MAX_SIZE = '200'
  const appOld = () => fs.readFileSync(path.join(getLogDir(), 'app.log.old'), 'utf8')

  // 写入足够内容触发轮转
  for (let i = 0; i < 10; i++) {
    logger.info('__TEST_ROTATE_' + i + '__')
  }
  delete process.env.LOG_MAX_SIZE

  // .old 存在且包含轮转前的记录；app.log 被重置为不超过阈值的大小
  assert.ok(fs.existsSync(path.join(getLogDir(), 'app.log.old')), 'app.log.old 应生成')
  assert.ok(appOld().includes('__TEST_ROTATE_'))
  const newSize = fs.statSync(path.join(getLogDir(), 'app.log')).size
  assert.ok(newSize <= 200, '轮转后 app.log 不应超过阈值（实际 ' + newSize + '）')
})

test('重复轮转只保留一份 .old，不产生 .old.old 链', () => {
  process.env.LOG_MAX_SIZE = '100'
  // 多轮写入触发多次轮转
  for (let i = 0; i < 10; i++) logger.info('__TEST_OLD_1_' + i + '__')
  for (let i = 0; i < 10; i++) logger.info('__TEST_OLD_2_' + i + '__')
  delete process.env.LOG_MAX_SIZE

  const oldPath = path.join(getLogDir(), 'app.log.old')
  assert.ok(fs.existsSync(oldPath), 'app.log.old 应存在')
  assert.ok(!fs.existsSync(oldPath + '.old'), '不应产生 .old.old 链')
  assert.ok(fs.statSync(oldPath).size > 0, '.old 应有内容')
  // app.log 本身仍可继续写入
  logger.info('__TEST_AFTER_ROTATE__')
  assert.ok(appLog().includes('__TEST_AFTER_ROTATE__'))
})
