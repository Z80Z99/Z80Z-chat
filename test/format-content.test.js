import { test } from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml, formatMessageContent } from '../frontend/src/utils/escape.ts'

test('escapeHtml 转义 HTML 标签', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;')
})

test('escapeHtml 转义全部特殊字符', () => {
  assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;')
})

test('formatMessageContent 先转义后高亮：外层标签不执行', () => {
  const out = formatMessageContent('<b>@everyone</b>')
  assert.ok(!out.includes('<b>'), '原始 <b> 不应出现')
  assert.ok(out.includes('&lt;b&gt;'), '应显示为转义文本')
  assert.ok(out.includes('@everyone</span>'), '@everyone 仍被高亮')
})

test('formatMessageContent 保留 @用户名 高亮', () => {
  const out = formatMessageContent('hi @alice')
  assert.ok(out.includes('@alice</span>'), '@alice 应被高亮')
  assert.equal(out.indexOf('<span'), out.lastIndexOf('<span'), '仅一处高亮 span')
})

test('formatMessageContent 中和 script 标签', () => {
  const out = formatMessageContent('<script>alert(1)</script>')
  assert.ok(!out.includes('<script>'), '不得包含可执行 script')
  assert.ok(out.includes('&lt;script&gt;'), '应显示为转义文本')
})

test('formatMessageContent 转义后不破坏普通文本', () => {
  const out = formatMessageContent('a & b < c > d "e" \'f\'')
  assert.ok(out.includes('a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;'))
})
