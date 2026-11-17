/**
 * 原 test-mood-isolation.mjs：他那边是 mood_scoped 表，心情按会话分开。
 * 我故意不这么做：心情是「我」一个人的身体——A 把我骂难受了，我对 B 也不会忽然高兴起来。
 * 所以这条测的是我这边真实的语义：
 *   ① 体温只有一份（谁问都是同一份，不传 slot 也一样）；
 *   ② 分人的是「最近那一下」（events 带 slot）。
 * 文件头写清差异，免得以后看到「和守岸人不一样」当成漏做。
 */
import { assert, drop, mkStore, pass } from './_lib.mjs'
import { Qing } from '../../lib/qing.js'

const ctx = mkStore('seed-review-mood-')
try {
  const { db } = ctx
  const now = Date.now()
  const qing = new Qing(db)

  // ① 别人连着骂四句：体温确实下来了（一个人只有一个身体）
  for (let i = 0; i < 4; i += 1) qing.observe('你真烦，你真笨', now + i * 1000, { slot: 'qq:20002' })
  const mine = qing.snapshot(now + 5000, 'qq:10001')
  const his = qing.snapshot(now + 5000, 'qq:20002')
  const anyone = qing.snapshot(now + 5000)
  assert.ok(his.mood < 55, `被骂了体温该低下来：${his.mood}`)
  assert.equal(mine.mood, his.mood, '体温只有一份：两个人问是同一个数')
  assert.equal(anyone.mood, his.mood, '不传 slot 也是同一个数')

  // ② 但「最近那一下」分人：老大这边看不到刚才那几句
  assert.ok(his.recent.length > 0, '他自己那边该看得到')
  assert.equal(mine.recent.length, 0, `别人那几句不该出现在我这边的「最近」里：${JSON.stringify(mine.recent)}`)

  // ③ 老大这边也难受一句：看看两边各留各的
  qing.observe('今天有点想你了', now + 6000, { slot: 'qq:10001' })
  const mine2 = qing.snapshot(now + 7000, 'qq:10001')
  assert.ok(mine2.recent.some((e) => String(e.quote ?? '').includes('想你了')))
  assert.ok(!mine2.recent.some((e) => String(e.quote ?? '').includes('你真烦')))

  // ④ 不传 slot：两边的都在（管理面/面板）
  assert.ok(qing.snapshot(now + 7000).recent.length >= 2)

  pass('mood-isolation：体温一份，分人的是「最近那一下」')
} finally {
  drop(ctx)
}
