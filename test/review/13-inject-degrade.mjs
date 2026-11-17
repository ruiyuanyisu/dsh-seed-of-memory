/**
 * 原 test-inject-degrade.mjs：卡片十二段是不是各在各的 try 里；最外层挂了剩下什么。
 * 这条只能静态读源码——注入链是 DSH 的 systemPrompt.context 回调，测试里拿不到那个上下文。
 * 断言的是「每一段都有兜底」这个结构，不是文案本身；文案只验最外层那句最关键的。
 */
import { assert, pass, src } from './_lib.mjs'

const code = src('lib/index.js')
const start = code.indexOf('coreText = ')
const end = code.indexOf('记忆卡拼装失败')
assert.ok(start > 0 && end > start, '找不到卡片拼装那段')
const card = code.slice(start, end)

/** 某一段变量在赋值前后有没有 try 包着。 */
function guarded(marker) {
  const at = card.indexOf(marker)
  assert.ok(at > 0, `卡片里找不到 ${marker}`)
  const before = card.slice(Math.max(0, at - 400), at)
  const after = card.slice(at, at + 400)
  return before.includes('try {') && (after.includes('catch') || after.includes('} catch'))
}

for (const marker of [
  'coreText = core.text',
  'card = store.card(',
  'line = emotionLine()',
  'const line = affectLine(',
  'const line = personaLine(',
  'const line = styleLine(',
  'captureHint = captureLine(',
  'const line = behaviorLine(',
  'storageNote = storageLine(',
  'const contact = getContact(',
]) {
  assert.ok(guarded(marker), `${marker} 这一段该自己兜着`)
}

// 最外层：挂了也要留固定底色，不能 return ''
assert.ok(card.includes("'[Seed of Memory · 根]"), '最外层该留固定底色，而不是空串')
assert.ok(code.includes('这一轮记忆卡拼装出错了，只剩固定底色'), '最外层兜底文案该在')
assert.ok(!/catch[\s\S]{0,200}return ''/.test(card), '最外层不该 return 空串')

pass('inject-degrade：卡片每一段各自兜底，最外层挂了也留固定底色')
