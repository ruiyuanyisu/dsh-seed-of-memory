/**
 * 原 test-factkey-cross.mjs：同一个 factKey，两个人的说法不同 / 相同，验库里的条数与状态。
 * 场景：老大说「他养猫」，QQ 上某人说「他养狗」——两码事，不能互相覆盖。
 */
import { assert, drop, mkStore, pass, rows } from './_lib.mjs'

const ctx = mkStore('seed-review-factkey-')
try {
  const { store } = ctx
  const A = 'qq:10001'
  const B = 'qq:20002'

  // ① 不同内容：两条都在，都 active
  store.remember({ text: '他养了一只猫', layer: 'semantic', factKey: 'pet', scope: A })
  store.remember({ text: '他养了一条狗', layer: 'semantic', factKey: 'pet', scope: B })
  const active = rows(
    ctx.db,
    "SELECT scope, text FROM memories WHERE fact_key = 'pet' AND status = 'active' ORDER BY scope",
  )
  assert.equal(active.length, 2, `同键两个档该各留一条：${JSON.stringify(active)}`)
  assert.equal(active[0].scope, A)
  assert.equal(active[1].scope, B)

  // ② 同一档里再说一遍不同内容：老的退场，新的接上（同键冲突只在本人档里算）
  store.remember({ text: '他养了两只猫', layer: 'semantic', factKey: 'pet', scope: A })
  const aActive = rows(
    ctx.db,
    "SELECT text FROM memories WHERE fact_key = 'pet' AND scope = ? AND status = 'active'",
    A,
  )
  assert.deepEqual(aActive.map((r) => r.text), ['他养了两只猫'], '自己那一档该被新说法接管')
  const aRetired = rows(
    ctx.db,
    "SELECT text FROM memories WHERE fact_key = 'pet' AND scope = ? AND status <> 'active'",
    A,
  )
  assert.equal(aRetired.length, 1, '老说法退场但留着')

  // ③ 别人的那条一点没动
  assert.equal(store.get(
    rows(ctx.db, "SELECT id FROM memories WHERE fact_key = 'pet' AND scope = ?", B)[0].id,
  ).status, 'active')

  pass('factkey-cross：同键只在本人档里撞，别人的说法不被顶掉')
} finally {
  drop(ctx)
}
