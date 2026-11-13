import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase, closeDatabase } from '../lib/db.js'
import { SeedStore } from '../lib/store.js'
import {
  backfillTiers,
  planConsolidation,
  applyConsolidation,
  consolidationView,
} from '../lib/consolidate.js'

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'seed-consolidate-'))
  const db = openDatabase(join(dir, 'seed.db'))
  try {
    fn(db, dir)
  } finally {
    closeDatabase(db)
    rmSync(dir, { recursive: true, force: true })
  }
}

test('backfillTiers 把 episodic / buffer 改成 short / working', () =>
  withDb((db) => {
    const store = new SeedStore(db)
    const a = store.remember({ text: '今天她有点累', layer: 'episodic' })
    const b = store.remember({ text: '刚在看 consolidate.js', layer: 'buffer' })
    // 手动抹成默认 long，模拟老数据
    db.prepare("UPDATE memories SET tier = 'long', expires_at = NULL").run()
    backfillTiers(db)
    assert.equal(store.get(a.id).tier, 'short')
    assert.equal(store.get(b.id).tier, 'working')
    assert.ok(store.get(b.id).expires_at > 0)
  }))

test('写入时按层给出 tier，工作记忆带过期时间', () =>
  withDb((db) => {
    const store = new SeedStore(db)
    const semantic = store.remember({ text: '她怕冷', layer: 'semantic' })
    const buffer = store.remember({ text: '正在改库结构', layer: 'buffer' })
    assert.equal(store.get(semantic.id).tier, 'long')
    assert.equal(store.get(buffer.id).tier, 'working')
    assert.ok(store.get(buffer.id).expires_at > Date.now()) // 工作记忆带 7 天过期时间
  }))

test('够格与到期分别生成 promote / expire', () =>
  withDb((db, dir) => {
    const store = new SeedStore(db)
    const good = store.remember({ text: '她说过记住要留一点余量', layer: 'episodic', importance: 0.9 })
    db.prepare('UPDATE memories SET tier = ?, recalls = 5, session_count = 3 WHERE id = ?').run('short', good.id)
    const stale = store.remember({ text: '刚才在试语音', layer: 'buffer' })
    db.prepare('UPDATE memories SET tier = ?, expires_at = ? WHERE id = ?').run('working', Date.now() - 1000, stale.id)

    const actions = planConsolidation(db)
    const promote = actions.find((a) => a.row.id === good.id)
    const expire = actions.find((a) => a.row.id === stale.id)
    assert.equal(promote?.action, 'promote')
    assert.equal(expire?.action, 'expire')
    assert.ok(promote.reasons.length > 0)
  }))

test('apply 会改层、退场并写日志', () =>
  withDb((db) => {
    const store = new SeedStore(db)
    const row = store.remember({ text: '记住：她希望重大决定先问她', layer: 'episodic', importance: 0.9 })
    db.prepare('UPDATE memories SET tier = ?, recalls = 5, session_count = 3 WHERE id = ?').run('short', row.id)
    const actions = planConsolidation(db)
    const done = applyConsolidation(db, actions)
    assert.equal(done.promoted, 1)
    const after = store.get(row.id)
    assert.equal(after.tier, 'long')
    assert.equal(after.expires_at, null)
    const log = db.prepare('SELECT * FROM consolidation_log').all()
    assert.equal(log.length, 1)
    assert.equal(log[0].memory_id, row.id)
    assert.equal(log[0].action, 'promote')
  }))

test('apply 对过期的 working 记忆执行退场', () =>
  withDb((db) => {
    const store = new SeedStore(db)
    const row = store.remember({ text: '刚才在翻聊天记录', layer: 'buffer' })
    db.prepare('UPDATE memories SET tier = ?, expires_at = ? WHERE id = ?').run('working', Date.now() - 1, row.id)
    const actions = planConsolidation(db)
    const done = applyConsolidation(db, actions)
    assert.equal(done.expired, 1)
    assert.equal(store.get(row.id).status, 'retired')
  }))

test('consolidationView 返回分层数量与最近日志', () =>
  withDb((db) => {
    const store = new SeedStore(db)
    store.remember({ text: '她怕冷', layer: 'semantic' })
    store.remember({ text: '今天心情不错', layer: 'episodic' })
    const view = consolidationView(db)
    assert.ok(Array.isArray(view.tiers))
    const total = view.tiers.reduce((sum, row) => sum + Number(row.n), 0)
    assert.equal(total, 2)
    assert.deepEqual(view.recent, [])
  }))
