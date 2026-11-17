import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../lib/db.js'
import {
  addLoose,
  listLoose,
  closeLoose,
  looseLines,
  markReplied,
  extractQuestion,
  LOOSE_HOURS,
} from '../lib/loose.js'

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), 'seed-'))
  const db = openDatabase(path.join(dir, 'seed.db'))
  return { db, dir }
}

function done(ctx) {
  ctx.db.close()
  rmSync(ctx.dir, { recursive: true, force: true })
}

test('未完话头：只从问句里挑，最后一句为准', () => {
  assert.equal(extractQuestion('今天下雨了。你带伞了吗？'), '你带伞了吗？')
  assert.equal(extractQuestion('饭吃了没？'), '饭吃了没？')
  assert.equal(extractQuestion('这样行不行呢'), '这样行不行呢')
  assert.equal(extractQuestion('今天很累。'), '')
  assert.equal(extractQuestion(''), '')
  assert.equal(extractQuestion(null), '')
})

test('未完话头：记一条，默认两天后该问', () => {
  const ctx = fresh()
  try {
    const now = 1_800_000_000_000
    const row = addLoose(ctx.db, { peer: 'private:1', ask: '周末去山里吗？', now })
    assert.match(row.id, /^l_/)
    assert.equal(row.status, 'open')
    assert.equal(row.due_at - row.asked_at, LOOSE_HOURS * 3600 * 1000)
    assert.equal(listLoose(ctx.db).length, 1)
  } finally {
    done(ctx)
  }
})

test('未完话头：同一句没等到回音，只刷新时间不堆两条', () => {
  const ctx = fresh()
  try {
    const first = addLoose(ctx.db, { peer: 'private:1', ask: '周末去山里吗？', now: 1000 })
    const second = addLoose(ctx.db, { peer: 'private:1', ask: '周末去山里吗？', now: 5000 })
    assert.equal(second.id, first.id)
    assert.equal(listLoose(ctx.db).length, 1)
    assert.equal(second.asked_at, 5000)
  } finally {
    done(ctx)
  }
})

test('未完话头：他回话后标成 answered，等收', () => {
  const ctx = fresh()
  try {
    const row = addLoose(ctx.db, { peer: 'group:9', ask: '群里那个文件发我看看？', now: 1000 })
    assert.equal(markReplied(ctx.db, 'group:9', 2000), 1)
    const opened = listLoose(ctx.db, { status: 'open' })
    assert.equal(opened.length, 0)
    const answered = listLoose(ctx.db, { status: 'answered' })
    assert.equal(answered.length, 1)
    const lines = looseLines(ctx.db, 'group:9', { now: 3000 })
    assert.ok(lines.some((line) => /他这次回了/.test(line)), lines.join('|'))
    const closed = closeLoose(ctx.db, { id: row.id, status: 'done', note: '发了', now: 4000 })
    assert.equal(closed.status, 'done')
    assert.equal(closed.note, '发了')
  } finally {
    done(ctx)
  }
})

test('未完话头：没收的时候，提示里带小时数；收掉的就不再出现', () => {
  const ctx = fresh()
  try {
    const row = addLoose(ctx.db, { peer: 'private:2', ask: '那句话是什么意思？', now: 0 })
    const lines = looseLines(ctx.db, 'private:2', { now: 10 * 3600 * 1000 })
    assert.ok(lines.some((line) => /10 小时前问过/.test(line)), lines.join('|'))
    closeLoose(ctx.db, { id: row.id, status: 'cancel', now: 20_000 })
    assert.deepEqual(looseLines(ctx.db, 'private:2', { now: 30_000 }), [])
  } finally {
    done(ctx)
  }
})

test('未完话头：cancel 和 update 分开记', () => {
  const ctx = fresh()
  try {
    const a = addLoose(ctx.db, { peer: 'private:3', ask: '用不用我改？', now: 1 })
    const b = addLoose(ctx.db, { peer: 'private:3', ask: '要不要加日志？', now: 2 })
    assert.equal(closeLoose(ctx.db, { id: a.id, status: 'cancel' }).status, 'cancelled')
    assert.equal(closeLoose(ctx.db, { id: b.id, status: 'update' }).status, 'updated')
    assert.equal(closeLoose(ctx.db, { id: 'l_missing', status: 'done' }), null)
  } finally {
    done(ctx)
  }
})
