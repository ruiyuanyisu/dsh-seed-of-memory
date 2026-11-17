/**
 * 原 test-slot-isolation.mjs：一条会话的情绪账不窜到另一条。
 * 接口差异：他给 qing 加了 use(slot) 切账本；我没有这个——心情只有一份身体，
 * 分人的是 tones（连着骂的计数）和 emotions（最近那一下）。这条按我的语义验，
 * 另外验老数据（没有 slot 的）默认算进 gui，升级后不会凭空丢。
 */
import { assert, drop, mkStore, pass } from './_lib.mjs'
import { Qing } from '../../lib/qing.js'

const ctx = mkStore('seed-review-slot-')
try {
  const { db } = ctx
  const now = Date.now()
  const qing = new Qing(db)

  // ① A 连骂两句：A 那边是「连着第二句」，B 那边还是干净的
  qing.observe('你真笨', now, { slot: 'qq:10001' })
  qing.observe('你真笨', now + 1000, { slot: 'qq:10001' })
  qing.observe('你好呀', now + 2000, { slot: 'qq:20002' })
  const tonesA = qing.streak(now + 2500, 'qq:10001')
  const tonesB = qing.streak(now + 2500, 'qq:20002')
  assert.equal(tonesA.length, 2, `A 的连骂计数：${JSON.stringify(tonesA)}`)
  assert.equal(tonesB.length, 1, `B 只说过一句：${JSON.stringify(tonesB)}`)
  assert.ok(tonesA.every((t) => t.slot === 'qq:10001'))

  // ② 不传 slot：所有 tones 一起算（管理面/老调用方）
  assert.equal(qing.streak(now + 2500).length, 3)

  // ③ 老数据没有 slot 字段：默认当 gui，不能丢
  qing.state.tones = [{ kind: 'blame', at: now + 3000 }]
  assert.equal(qing.streak(now + 3100, 'gui').length, 1, '没有 slot 的老数据算 gui')

  pass('slot-isolation：连骂的计数分人；老数据默认归 gui')
} finally {
  drop(ctx)
}
