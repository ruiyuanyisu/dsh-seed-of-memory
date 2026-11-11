import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase, closeDatabase } from '../lib/db.js'
import {
  ensureDefaultHabits,
  listHabits,
  observeHabit,
  styleLine,
  styleSummary,
  normalize,
  DAILY_CAP,
  ACTIVE_AT,
} from '../lib/style.js'

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'seed-style-'))
  const db = openDatabase(join(dir, 'seed.db'))
  try {
    return fn(db)
  } finally {
    closeDatabase(db)
    rmSync(dir, { recursive: true, force: true })
  }
}

test('default habits are seeded once, not twice', () => {
  withDb((db) => {
    const added = ensureDefaultHabits(db)
    assert.equal(added, 2)
    assert.equal(ensureDefaultHabits(db), 0)
    const rows = listHabits(db)
    assert.equal(rows.length, 2)
    assert.ok(rows.some((row) => row.statement.includes('软')))
    assert.ok(rows.some((row) => row.status === 'active'))
  })
})

test('repeated observations stack strength and become active', () => {
  withDb((db) => {
    const statement = '先接一句，再展开'
    const day = Date.parse('2026-11-11T10:00:00')
    let last = observeHabit(db, { statement, key: 'opening' }, day)
    assert.equal(last.status, 'candidate')
    assert.equal(styleLine(db), '')

    for (let i = 1; i <= 10; i += 1) {
      last = observeHabit(db, { statement, key: 'opening' }, day + i * 24 * 60 * 60 * 1000)
    }
    assert.equal(last.status, 'active')
    assert.ok(last.strength >= ACTIVE_AT)
    assert.match(styleLine(db), /先接一句/)
  })
})

test('daily cap limits growth per day', () => {
  withDb((db) => {
    const statement = '句子短一点'
    const day = Date.parse('2026-11-11T10:00:00')
    observeHabit(db, { statement, delta: 0.12 }, day)
    const capped = observeHabit(db, { statement, delta: 0.12 }, day + 60_000)
    assert.equal(capped.applied, 0.03)
    const nextDay = observeHabit(db, { statement, delta: 0.12 }, day + 24 * 60 * 60 * 1000)
    assert.ok(nextDay.applied > 0)
    assert.ok(nextDay.strength <= 0.15 + DAILY_CAP + DAILY_CAP + 0.001)
  })
})

test('counter-examples go into counter and lower strength', () => {
  withDb((db) => {
    const statement = '偶尔用一下「呀」'
    observeHabit(db, { statement, delta: 0.1 })
    const down = observeHabit(db, { statement, delta: -0.06 })
    assert.equal(down.applied, -0.06)
    assert.ok(down.counter.length >= 1)
    assert.ok(down.strength < 0.2)
  })
})

test('normalize collapses punctuation and spaces so the same habit merges', () => {
  withDb((db) => {
    const a = observeHabit(db, { statement: '先接一句，再展开。' })
    const b = observeHabit(db, { statement: '先接一句 再展开' })
    assert.equal(a.id, b.id)
    assert.equal(normalize('先接一句，再展开。'), normalize('先接一句 再展开'))
  })
})

test('style line only shows active habits and stays short', () => {
  withDb((db) => {
    assert.equal(styleLine(db), '')
    const day = Date.parse('2026-11-11T10:00:00')
    const statements = [
      '说话放软一点，不用命令句',
      '先接住她的话，再讲自己的',
      '少用长定语，一句话说完一层',
      '偶尔留一点没说完的余地',
    ]
    for (const statement of statements) {
      observeHabit(db, { statement, delta: 0.3 }, day)
      observeHabit(db, { statement, delta: 0.3 }, day + 24 * 60 * 60 * 1000)
    }
    const line = styleLine(db)
    assert.ok(line.length > 0)
    assert.ok(line.length <= 80)
    assert.ok(line.includes('说话放软一点'))
    assert.ok(styleSummary(db).includes('说话习惯'))
  })
})

test('a retired habit is hidden from the list by default', () => {
  withDb((db) => {
    const row = observeHabit(db, { statement: '不说「您」' })
    db.prepare("UPDATE habits SET status = 'retired' WHERE id = ?").run(row.id)
    assert.equal(listHabits(db).length, 0)
    assert.equal(listHabits(db, { includeRetired: true }).length, 1)
  })
})
