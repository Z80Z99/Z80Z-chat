import { test } from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml, formatMessageContent, messageContentText } from '../frontend/src/utils/escape.ts'

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
  assert.ok(out.includes('@everyone'), '保留原始文字')
})

test('未选择成员的普通 @用户名 保留文字，不伪装成身份提及', () => {
  const out = formatMessageContent('hi @alice')
  assert.equal(out, 'hi @alice')
})

test('结构化提及使用成员 ID，昵称和正文中的 HTML 都不能执行', () => {
  const users = [{ id: 'member-a', nickname: '小明<img src=x onerror=alert(1)>', username: 'alice' }]
  const out = formatMessageContent('你好 <@member-a> <script>x</script>', users)
  assert.ok(out.includes('data-mention-id="member-a"'))
  assert.ok(out.includes('@小明&lt;img src=x onerror=alert(1)&gt;'))
  assert.ok(out.includes('&lt;script&gt;x&lt;/script&gt;'))
  assert.ok(!out.includes('<img') && !out.includes('<script>'))
  assert.equal(messageContentText('你好 <@member-a>', users), '你好 @小明<img src=x onerror=alert(1)>')
})

test('重名成员的提及入口保持各自 ID，改名只改变显示', () => {
  const users = [{ id: 'one', nickname: '同名' }, { id: 'two', nickname: '同名' }]
  const out = formatMessageContent('<@one> 和 <@two>', users)
  assert.ok(out.includes('data-mention-id="one"') && out.includes('data-mention-id="two"'))
  assert.equal(messageContentText('<@one>', [{ id: 'one', nickname: '新昵称' }]), '@新昵称')
  assert.equal(messageContentText('<@deleted>'), '@已离开的成员')
  assert.ok(!formatMessageContent('<@deleted>').includes('data-mention-id'))
})

test('仅服务端确认的独立 @everyone 高亮，邮件和名称片段不误认', () => {
  assert.ok(formatMessageContent('提醒 @everyone!', [], true).includes('message-mention-everyone'))
  assert.equal(formatMessageContent('提醒 @everyone!', [], false), '提醒 @everyone!')
  assert.equal(formatMessageContent('a@everyone.com @everyoneelse', [], true), 'a@everyone.com @everyoneelse')
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
