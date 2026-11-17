/**
 * 原 test-nested-txn.mjs：调用方已经开着事务时，整理记忆（applyConsolidation）不能把外层事务搞死。
 * 原来这里裸 BEGIN，嵌套时 SQLite 直接抛「cannot start a transaction within a transaction」；
 * 1.5.0 改成 SAVEPOINT。
 */
import { assert, drop, mkStore, pass, rows } from './_lib.mjs'
import { applyConsolidation, planConsolidation } from '../../lib/consolidate.js'

const ctx = mkStore('seed-review-txn-')
try {
  const { db, store } = ctx
  const now = Date.now()

  // 造三条够格的旧记忆，让 planConsolidation 有话可做
  for (let i = 0; i < 3; i += 1) {
    const { id } = store.remember({ text: `很久以前的事${i}`, layer: 'episodic', importance: 0.4 })
    db.prepare('UPDATE memories SET recorded_at = ? WHERE id = ?').run(now - 400 * 86_400_000, id)
  }

  // 外层事务开着，里面调整理
  db.exec('BEGIN')
  db.prepare("INSERT INTO mood (id, valence, arousal, label, cause, updated_at) VALUES (1, 0.2, 0.3, '平静', NULL, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at").run(now)
  const actions = planConsolidation(db, { now })
  assert.ok(Array.isArray(actions), 'planConsolidation 该给一个数组')
  let threw = null
  try {
    applyConsolidation(db, actions, { now })
  } catch (error) {
    threw = error
  }
  assert.equal(threw, null, `嵌套时不该抛：${threw?.message}`)
  db.exec('COMMIT')

  // 外层事务真提交了：刚才那条 mood 还在
  assert.ok(rows(db, 'SELECT * FROM mood').length >= 1, '外层事务该还能提交')

  pass('nested-txn：外层事务开着时整理记忆不炸，外层还能正常提交')
} finally {
  drop(ctx)
}
