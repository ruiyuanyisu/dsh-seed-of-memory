/**
 * 原 test-belief-cross.mjs：同 factKey 两人说法不同，不互相顶掉；
 * 同一句话两人各一条；beliefs 表有 scope 列。
 */
import { assert, columns, drop, mkStore, pass, rows } from './_lib.mjs'
import { listBeliefs, rememberBelief } from '../../lib/beliefs.js'

const ctx = mkStore('seed-review-belief-')
try {
  const { db } = ctx
  const A = 'qq:10001'
  const B = 'qq:20002'

  assert.ok(columns(db, 'beliefs').includes('scope'), 'beliefs 该有 scope 列')

  // ① 同 factKey、内容不同：两条都要留着
  const a = rememberBelief(db, { claim: '老大在做记忆插件', factKey: 'project', scope: A })
  const b = rememberBelief(db, { claim: '老大在写小说', factKey: 'project', scope: B })
  assert.notEqual(a.id, b.id, '两个人同键不该合成一条')
  assert.equal(rows(db, "SELECT * FROM beliefs WHERE status='active' AND fact_key='project'").length, 2)

  // ② 同 factKey、同一句话：各一条，也不互相顶掉
  const c = rememberBelief(db, { claim: '今天下雨', factKey: 'weather', scope: A })
  const d = rememberBelief(db, { claim: '今天下雨', factKey: 'weather', scope: B })
  assert.notEqual(c.id, d.id, '同一句话落在两个档，是两条')
  assert.equal(rows(db, "SELECT * FROM beliefs WHERE status='active' AND fact_key='weather'").length, 2)

  // ③ 自己那一档里的重复说法才该收敛：同一档同句再来一次，还是那条
  const again = rememberBelief(db, { claim: '今天下雨', factKey: 'weather', scope: A })
  assert.equal(again.id, c.id, '同一个档里同键同句，该回到原来那条')

  // ④ 看的时候各看各的
  const seenA = listBeliefs(db, { scope: A, includeRetired: true }).map((x) => x.claim)
  assert.ok(seenA.includes('老大在做记忆插件'), 'A 该看到自己的')
  assert.ok(!seenA.includes('老大在写小说'), 'A 不该看到 B 的')

  pass('belief-cross：同一个键在两个档里各算各的，说法相同也不互相顶掉')
} finally {
  drop(ctx)
}
