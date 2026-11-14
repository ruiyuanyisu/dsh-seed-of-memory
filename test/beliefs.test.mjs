import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../lib/db.js'
import { rememberBelief, listBeliefs, getBelief } from '../lib/beliefs.js'

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