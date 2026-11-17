/**
 * 原 test-proactive-cross.mjs：主动找人的时候，取的是谁的心情。
 * 他那边有 snapshotOf(slot)；我这边是 qing.snapshot(now, slot)——共用一个身体，
 * 但「最近那一下」按 slot 各留各的。
 * 这条验：给主人看的那份里，不该混进张三刚骂我的那几句。
 */
import { assert, drop, mkStore, pass } from './_lib.mjs'
import { Qing } from '../../lib/qing.js'

const ctx = mkStore('seed-review-proactive-')
try {
  const { db } = ctx
  const now = Date.now()
  const qing = new Qing(db)

  qing.observe('你真笨，烦死了', now, { slot: 'qq:20002' })
  qing.observe('你真笨，烦死了', now + 1000, { slot: 'qq:20002' })
  qing.observe('今天想你了', now + 2000, { slot: 'qq:10001' })

  const owner = qing.snapshot(now + 3000, 'qq:10001')
  assert.ok(owner.recent.some((e) => String(e.quote ?? '').includes('想你了')), '主人那一档该有自己的')
  assert.ok(
    !owner.recent.some((e) => String(e.quote ?? '').includes('烦死了')),
    `别把别人那条端给主人：${JSON.stringify(owner.recent.map((e) => e.quote))}`,
  )

  const stranger = qing.snapshot(now + 3000, 'qq:20002')
  assert.ok(stranger.recent.some((e) => String(e.quote ?? '').includes('烦死了')))
  assert.ok(!stranger.recent.some((e) => String(e.quote ?? '').includes('想你了')))

  // 取别人的档不该把我的状态改掉（快照是只读的）
  const before = JSON.stringify(qing.snapshot(now + 3000, 'qq:10001'))
  qing.snapshot(now + 3000, 'qq:20002')
  assert.equal(JSON.stringify(qing.snapshot(now + 3000, 'qq:10001')), before, '读别人的档不该动我的')

  pass('proactive-cross：主动消息取主人那一档的「最近那一下」')
} finally {
  drop(ctx)
}
