import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../lib/db.js'
import {
  BELIEF_CONFIDENCE_FLOOR,
  effectiveConfidence,
  getBelief,
  listBeliefs,
  rememberBelief,
  setBeliefStatus,
} from '../lib/beliefs.js'

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'seed-belief-'))
  const db = openDatabase(join(dir, 'seed.db'))
  return { db, dir }
}

function done(ctx) {
  ctx.db.close()
  rmSync(ctx.dir, { recursive: true, force: true })
}

test('同一句话的认知不该记成两条', () => {
  const ctx = fresh()
  const now = Date.now()
  const a = rememberBelief(ctx.db, { claim: '他不喜欢被催' }, now)
  const b = rememberBelief(ctx.db, { claim: '他不喜欢被催' }, now + 1)
  assert.equal(b.merged, true)
  assert.equal(b.id, a.id)
  const rows = listBeliefs(ctx.db, { limit: 10 })
  assert.equal(rows.length, 1)
  done(ctx)
})

test('两句不同的认知各留各的', () => {
  const ctx = fresh()
  const now = Date.now()
  rememberBelief(ctx.db, { claim: '他不喜欢被催' }, now)
  rememberBelief(ctx.db, { claim: '他喜欢夜里听雨' }, now + 1)
  assert.equal(listBeliefs(ctx.db, { limit: 10 }).length, 2)
  done(ctx)
})

test('同一个键换了说法：旧的退场、留取代链', () => {
  const ctx = fresh()
  const now = Date.now()
  const old = rememberBelief(ctx.db, { claim: '他不喜欢被催', factKey: '他.被催' }, now)
  const next = rememberBelief(ctx.db, { claim: '他只是不喜欢被安排，不排斥提醒', factKey: '他.被催' }, now + 1)
  assert.equal(next.superseded, old.id)
  const before = getBelief(ctx.db, old.id)
  assert.equal(before.status, 'retired')
  assert.equal(before.superseded_by, next.id)
  assert.equal(listBeliefs(ctx.db, { limit: 10 }).length, 1)
  done(ctx)
})
test('当面把共用层的认知改掉：改的是那一条，不并排两个版本', () => {
  const ctx = fresh()
  const now = Date.now()
  const shared = rememberBelief(ctx.db, { claim: '他叫阿甲', factKey: '他.名字', scope: 'shared' }, now)
  const gui = rememberBelief(ctx.db, { claim: '他叫阿乙', factKey: '他.名字', scope: 'gui' }, now + 1)
  assert.equal(gui.superseded, shared.id)
  assert.equal(getBelief(ctx.db, shared.id).status, 'retired')
  assert.equal(getBelief(ctx.db, gui.id).scope, 'shared', '新那条还是共用的：QQ 那边也得看见')
  const active = ctx.db
    .prepare("SELECT scope, claim FROM beliefs WHERE fact_key = '他.名字' AND status = 'active'")
    .all()
  assert.deepEqual(active.map((row) => [row.scope, row.claim]), [['shared', '他叫阿乙']])
  done(ctx)
})

test('同一条认知说五遍，置信度封在 0.95：重复不等于越来越确信', () => {
  const ctx = fresh()
  const now = Date.now()
  let last = null
  for (let i = 0; i < 5; i += 1) {
    last = rememberBelief(ctx.db, { claim: '他不喜欢被催', confidence: 0.99 }, now + i)
  }
  assert.equal(getBelief(ctx.db, last.id).confidence, 0.95)
  done(ctx)
})

test('九十天没人再印证，认知会淡：半衰期九十天，淡到底也不归零', () => {
  const ctx = fresh()
  const now = Date.now()
  const r = rememberBelief(ctx.db, { claim: '他不喜欢被催', confidence: 0.9 }, now)
  const row = getBelief(ctx.db, r.id)
  const today = effectiveConfidence(row, now)
  assert.ok(today > 0.89, `刚写下时应该是 0.9 左右，实际 ${today}`)
  const after90 = effectiveConfidence(row, now + 90 * 86_400_000)
  const expected = BELIEF_CONFIDENCE_FLOOR + (0.9 - BELIEF_CONFIDENCE_FLOOR) * 0.5
  assert.ok(Math.abs(after90 - expected) < 0.02, `九十天后应该约 ${expected.toFixed(2)}，实际 ${after90.toFixed(2)}`)
  const afterYear = effectiveConfidence(row, now + 365 * 86_400_000)
  assert.ok(afterYear > BELIEF_CONFIDENCE_FLOOR && afterYear < after90, '一年后更淡，但不低于地板')
  done(ctx)
})

test('候选不算认知：默认列表里看不到 pending，退休全开也不带出来', () => {
  const ctx = fresh()
  const now = Date.now()
  const kept = rememberBelief(ctx.db, { claim: '他喜欢夜里听雨' }, now)
  const cand = rememberBelief(ctx.db, { claim: '他讨厌被夸' }, now + 1)
  setBeliefStatus(ctx.db, cand.id, 'pending', now + 2)
  assert.deepEqual(listBeliefs(ctx.db, { limit: 10 }).map((r) => r.id), [kept.id])
  assert.equal(listBeliefs(ctx.db, { limit: 10, includePending: true }).length, 2)
  assert.equal(listBeliefs(ctx.db, { limit: 10, includeRetired: true }).length, 1)
  done(ctx)
})

test('重新承认一条存疑的认知，新鲜度从今天重算', () => {
  const ctx = fresh()
  const now = Date.now()
  const r = rememberBelief(ctx.db, { claim: '他不喜欢被催', confidence: 0.9 }, now)
  setBeliefStatus(ctx.db, r.id, 'contested', now + 1)
  const later = now + 100 * 86_400_000
  const before = effectiveConfidence(getBelief(ctx.db, r.id), later)
  setBeliefStatus(ctx.db, r.id, 'active', later)
  const after = effectiveConfidence(getBelief(ctx.db, r.id), later)
  assert.ok(after > before, `重新承认后应该回升：前 ${before.toFixed(2)}，后 ${after.toFixed(2)}`)
  done(ctx)
})
