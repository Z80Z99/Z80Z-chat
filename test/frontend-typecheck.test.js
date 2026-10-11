import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../', import.meta.url))
const testRoot = path.join(project, '.test-data')
const checker = path.join(project, 'node_modules', 'vue-tsc', 'bin', 'vue-tsc.js')

function checkTemplate(source) {
  fs.mkdirSync(testRoot, { recursive: true })
  const directory = fs.mkdtempSync(path.join(testRoot, 'template-check-'))
  try {
    fs.writeFileSync(path.join(directory, 'Probe.vue'), source)
    fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({
      extends: '../../frontend/tsconfig.json',
      include: ['Probe.vue']
    }))
    const result = spawnSync(process.execPath, [checker, '--noEmit', '-p', path.join(directory, 'tsconfig.json')], {
      cwd: project, encoding: 'utf8', windowsHide: true, timeout: 30000
    })
    assert.ifError(result.error)
    return { status: result.status, output: result.stdout + result.stderr }
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(testRoot) + path.sep))
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('完整 Vue 检查读取实际组件 props 和事件，合法 data 属性仍可使用', () => {
  const result = checkTemplate(`<script setup lang="ts">
import DeviceSelect from '../../frontend/src/components/DeviceSelect.vue'
import { ref } from 'vue'
const selected = ref('')
const devices = [{ deviceId: 'mic-a', label: '麦克风' }]
function change(value: string) { selected.value = value }
</script>
<template>
  <DeviceSelect :devices="devices" :model-value="selected" @change="change" />
  <div data-typecheck-probe="valid">{{ selected }}</div>
</template>`)
  assert.equal(result.status, 0, result.output)
})

test('完整 Vue 检查拒绝缺失 prop、错误事件参数和不存在的模板变量', () => {
  const result = checkTemplate(`<script setup lang="ts">
import DeviceSelect from '../../frontend/src/components/DeviceSelect.vue'
const devices = [{ deviceId: 'mic-a', label: '麦克风' }]
function change(value: number) { return value }
</script>
<template>
  <DeviceSelect :devices="devices" />
  <DeviceSelect :devices="devices" model-value="" @change="change" />
  <div>{{ missingTemplateValue }}</div>
</template>`)
  assert.notEqual(result.status, 0, 'invalid SFC must fail the actual checker')
  assert.match(result.output, /modelValue.*missing|missing.*modelValue/)
  assert.match(result.output, /string.*not assignable.*number|number.*not assignable.*string/)
  assert.match(result.output, /missingTemplateValue/)
})
