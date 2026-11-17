/**
 * 原 test-card-starve.mjs：semantic 层堆满长条目时，预算内「最近：」那层会不会被饿死。
 * 我的实现：semantic 先占，episodic 在剩下的预算里最多放两条；放不下就只留小标题。
 * 这里断言两件真事：① 卡不超预算、不抛；② 预算够时「最近」确实放得进来。
 */
import { assert, drop, mkStore, pass } from './_lib.mjs'

const ctx = mkStore('seed-review-card-')
try {
  const { store } = ctx
  const long = (n) => '雨'.repeat(n)
  for (let i = 0; i < 5; i += 1) {
    store.remember({ text: `长久记得的事${i}：${long(60)}`, layer: 'semantic', importance: 0.9 - i * 0.01 })
  }
  for (let i = 0; i < 3; i += 1) {
    store.remember({ text: `这几天发生的第${i}件事`, layer: 'episodic', importance: 0.5 })
  }

  const tight = store.card({ budget: 600, scope: 'shared' })
  assert.ok(tight.used <= 600, `卡片不该超预算：${tight.used}`)
  assert.ok(tight.text.length > 0, '卡片不该是空的')

  const roomy = store.card({ budget: 3000, scope: 'shared' })
  assert.ok(roomy.text.includes('最近：'), '预算宽的时候「最近」这层要出现')
  assert.ok(roomy.text.includes('这几天发生的第'), '预算宽的时候最近的事要进卡')
  assert.ok(roomy.used <= 3000, '宽预算也不该超')

  pass('card-starve：预算紧时不超、不崩；预算宽时「最近」放得进来')
} finally {
  drop(ctx)
}
