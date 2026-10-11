import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { collectFiles, buildProjectZip, computePayloadSha, parseReleaseConfig, assertSafeReleaseConfig } from '../scripts/build-single.js'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const testRoot = path.join(projectRoot, '.test-data')

function fixture(t) {
  fs.mkdirSync(testRoot, { recursive: true })
  const root = fs.mkdtempSync(path.join(testRoot, 'release-payload-'))
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(testRoot) + path.sep))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const write = (name, content = name) => {
    const full = path.join(root, name)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
    return full
  }
  return { root, write }
}

const snapshot = root => collectFiles(root, '', {}).map(file => ({ name: file.relPath, data: fs.readFileSync(file.full) }))

// 从中央目录读取实际 ZIP，再独立解压、核对局部头和 CRC，不依赖打包器内部条目。
function readZip(bytes) {
  const end = bytes.length - 22
  assert.equal(bytes.readUInt32LE(end), 0x06054b50)
  const count = bytes.readUInt16LE(end + 10)
  const centralSize = bytes.readUInt32LE(end + 12)
  let cursor = bytes.readUInt32LE(end + 16)
  assert.equal(cursor + centralSize, end)
  const entries = new Map()
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50)
    const flags = bytes.readUInt16LE(cursor + 8)
    const method = bytes.readUInt16LE(cursor + 10)
    const expectedCrc = bytes.readUInt32LE(cursor + 16)
    const compressedSize = bytes.readUInt32LE(cursor + 20)
    const size = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const offset = bytes.readUInt32LE(cursor + 42)
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    const name = nameBytes.toString('utf8')
    assert.equal(flags & 0x0800, 0x0800, `UTF-8 filename: ${name}`)
    assert.equal(method, 8)
    assert.equal(bytes.readUInt32LE(offset), 0x04034b50)
    assert.equal(bytes.readUInt16LE(offset + 6), flags)
    assert.equal(bytes.readUInt16LE(offset + 8), method)
    assert.equal(bytes.readUInt32LE(offset + 14), expectedCrc)
    assert.equal(bytes.readUInt32LE(offset + 18), compressedSize)
    assert.equal(bytes.readUInt32LE(offset + 22), size)
    const localNameLength = bytes.readUInt16LE(offset + 26)
    const localExtraLength = bytes.readUInt16LE(offset + 28)
    assert.deepEqual(bytes.subarray(offset + 30, offset + 30 + localNameLength), nameBytes)
    const dataStart = offset + 30 + localNameLength + localExtraLength
    const data = inflateRawSync(bytes.subarray(dataStart, dataStart + compressedSize))
    assert.equal(data.length, size)
    let crc = 0xffffffff
    for (const byte of data) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    assert.equal((crc ^ 0xffffffff) >>> 0, expectedCrc)
    assert.equal(entries.has(name), false)
    entries.set(name, data)
    cursor += 46 + nameLength + extraLength + commentLength
  }
  assert.equal(cursor, end)
  return entries
}

test('发布条目排除运行数据、隧道账号、环境文件及缓存，保留锁文件和 launcher', t => {
  const { root, write } = fixture(t)
  const allowed = ['config.json', 'package.json', 'package-lock.json', 'start.js', 'server.js', '.gitignore', '.gitattributes',
    'frontend/src/utils/voice-microphone.ts', 'frontend/src/utils/voice-audio-playback.ts', 'frontend/src/utils/voice-statistics.ts',
    'deploy/z80z-chat.service']
  for (const name of allowed) write(name, name === 'config.json' ? '{"uploadSecret":""}' : name)
  const privateFiles = ['data/db.json', 'logs/app.log', '.test-data/qa.log', 'node_modules/index.js', 'dist/index.html',
    'nodejs/node.exe', 'data-backup/backup-1/db.json', '.deploy-test/config.json', '.git/config', '.agents/settings.json',
    '.codex/config.toml', '.aws/credentials', 'cloudflared/settings.json', 'sakurafrp/settings.json', '.art-baseline/snapshot.png',
    '.art-snapshots/snapshot.png', '.install-version', '.install-config.json', '.npmrc', '.upload-secret', 'npm-install.log',
    '.env', '.env.production', '.npm-out-registry-1.txt', '.config.hidden-copy', '.update-stage-one/db.json',
    '.project-rollback-one/db.json', '.project-files-one/private.txt', '.payload-check-one/private.txt',
    'frontend/tsconfig.node.tsbuildinfo', 'nested/cache.tsbuildinfo', 'deploy/install.template.bat', 'start.bat', 'Z80Z-chat.bat',
    '.ENV.LOCAL', 'nested/private.TSBUILDINFO', '.CONFIG.old-copy', '.NPM-OUT-old.txt']
  for (const name of privateFiles) write(name, 'PRIVATE_FIXTURE_VALUE')
  const entries = snapshot(root)
  assert.deepEqual(entries.map(entry => entry.name).sort(), [...allowed].sort())
  const zip = readZip(buildProjectZip(entries))
  assert.deepEqual([...zip.keys()].sort(), [...allowed].sort())
  for (const data of zip.values()) assert.equal(data.includes(Buffer.from('PRIVATE_FIXTURE_VALUE')), false)
})

test('配置与环境中的自定义运行路径精确排除，保留父目录中的源码及相似目录', t => {
  const { root, write } = fixture(t)
  write('config.json', '{ /* 注释 */ "dataDir": "private/store", "uploadSecret": "" }')
  for (const name of ['private/store/db.json', 'private/override/uploads/private.png', 'private/log-output/app.log']) write(name)
  const allowed = ['config.json', 'private/source.js', 'private/store-copy/README.md']
  write('private/source.js'); write('private/store-copy/README.md')
  const env = { DATA_DIR: path.join(root, 'private/override'), LOG_DIR: 'private/log-output' }
  assert.deepEqual(collectFiles(root, '', env).map(file => file.relPath).sort(), [...allowed].sort())
  if (process.platform === 'win32') {
    write('config.json', '{"dataDir":"PRIVATE/STORE"}')
    assert.deepEqual(collectFiles(root, '', env).map(file => file.relPath).sort(), [...allowed].sort())
  }
})

test('外部运行目录不误排同名源码目录，项目根作为运行目录时拒绝打包', t => {
  const { root, write } = fixture(t)
  write('config.json', JSON.stringify({ dataDir: path.resolve(root, '../external-store') }))
  write('external-store/source.js')
  assert.deepEqual(collectFiles(root, '', { DATA_DIR: '../external-data', LOG_DIR: '../external-logs' }).map(file => file.relPath).sort(),
    ['config.json', 'external-store/source.js'])
  assert.throws(() => collectFiles(root, '', { DATA_DIR: '.' }), /项目根目录/)
  assert.throws(() => collectFiles(root, '', { LOG_DIR: root }), /项目根目录/)
  write('config.json', '{"dataDir":"."}')
  assert.throws(() => collectFiles(root, '', {}), /项目根目录/)
})

test('实际 ZIP 保留隐藏与 UTF-8 文件名、空文件和二进制内容，并读取同一快照', t => {
  const { root, write } = fixture(t)
  write('config.json', '{}')
  write('.隐藏文件', '中文内容')
  write('assets/图标 空格.bin', Buffer.from([0, 255, 128, 42]))
  write('assets/empty.txt', '')
  const entries = snapshot(root)
  const beforeHash = computePayloadSha(entries)
  write('.隐藏文件', '快照之后的修改')
  const zip = readZip(buildProjectZip(entries))
  assert.equal(zip.get('.隐藏文件').toString('utf8'), '中文内容')
  assert.deepEqual(zip.get('assets/图标 空格.bin'), Buffer.from([0, 255, 128, 42]))
  assert.equal(zip.get('assets/empty.txt').length, 0)
  assert.equal(computePayloadSha([...zip].map(([name, data]) => ({ name, data }))), beforeHash)
  assert.notEqual(computePayloadSha(snapshot(root)), beforeHash)
})

test('锁文件及 launcher 内容参与指纹，条目顺序和 package 版本字段不改变指纹规则', t => {
  const { root, write } = fixture(t)
  write('config.json', '{}'); write('package.json', '{"version":"1.0.8"}')
  write('package-lock.json', '{"lockfileVersion":3}'); write('start.js', 'console.log("first")')
  const entries = snapshot(root), original = computePayloadSha(entries)
  assert.equal(computePayloadSha([...entries].reverse()), original)
  write('package.json', '{"version":"1.0.9"}')
  assert.equal(computePayloadSha(snapshot(root)), original)
  write('start.js', 'console.log("second")')
  assert.notEqual(computePayloadSha(snapshot(root)), original)
  write('start.js', 'console.log("first")')
  write('package-lock.json', '{"lockfileVersion":3,"dependencies":{"vue-tsc":"3.3.13"}}')
  assert.notEqual(computePayloadSha(snapshot(root)), original)
})

test('发布配置接受带注释的默认公开账号，检查过程不改写配置文件', t => {
  const { root, write } = fixture(t)
  const source = `\uFEFF{ // 保留中文注释\n "uploadSecret": "", "siteName": "https://example.test/*literal*/",\n
    "iceServers": [{"urls":["turn:openrelay.metered.ca:80","turn:openrelay.metered.ca:443?transport=tcp"],
      "username":"openrelayproject","credential":"openrelayproject"}] /* 默认公开账号 */ }`
  const file = write('config.json', source), before = fs.readFileSync(file)
  assert.equal(assertSafeReleaseConfig(source).uploadSecret, '')
  assert.equal(parseReleaseConfig(source).siteName, 'https://example.test/*literal*/')
  assert.deepEqual(fs.readFileSync(file), before)
})

test('发布配置拒绝签名密钥及私有 ICE 账号，错误不包含秘密且原文件不变', t => {
  const { root, write } = fixture(t)
  for (const config of [
    { uploadSecret: 'private-marker' },
    { iceServers: [{ urls: 'turn:private.example:3478', username: 'private-marker', credential: 'private-marker' }] },
    { iceServers: [{ urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'private-marker' }] },
    { iceServers: [{ urls: ['turn:openrelay.metered.ca:80', 'turn:private.example:3478'], username: 'openrelayproject', credential: 'openrelayproject' }] }
  ]) {
    const source = JSON.stringify(config), file = write('config.json', source), before = fs.readFileSync(file)
    assert.throws(() => assertSafeReleaseConfig(source), error => {
      assert.match(error.message, /私有/)
      assert.doesNotMatch(error.message, /private-marker|private\.example/)
      return true
    })
    assert.deepEqual(fs.readFileSync(file), before)
  }
  assert.throws(() => parseReleaseConfig('{"uploadSecret":"private-marker", invalid}'), error => {
    assert.doesNotMatch(error.message, /private-marker/)
    return true
  })
})

test('当前发布源码条目包含锁文件和拆分模块，安全配置检查不修改源码配置', () => {
  const file = path.join(projectRoot, 'config.json'), before = fs.readFileSync(file)
  const names = new Set(collectFiles(projectRoot, '', {}).map(entry => entry.relPath))
  for (const name of ['package-lock.json', 'start.js', 'frontend/src/utils/voice-microphone.ts',
    'frontend/src/utils/voice-audio-playback.ts', 'frontend/src/utils/voice-statistics.ts', 'frontend/src/components/CommunityProfileEditor.vue']) {
    assert.equal(names.has(name), true, name)
  }
  assertSafeReleaseConfig(before.toString('utf8'))
  assert.deepEqual(fs.readFileSync(file), before)
})
