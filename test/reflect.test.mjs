import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase, closeDatabase } from '../lib/db.js'
import { reflectReply, reflectTurn, behaviorLine } from '../lib/reflect.js'
import { observeTrait, listTraits, setAspiration } from '../lib/persona.js'
import { listHabits } from '../lib/style.js'

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'seed-reflect-'))
  const db = openDatabase(join(dir, 'seed.db'))
  try {
    return fn(db)
  } finally {
    closeDatabase(db)
    rmSync(dir, { recursive: true, force: true })
  }
}

test('reflectReply 认出承认不确定', () => {
  const signals = reflectReply('这个我不确定，可能是配置没生效。')
  assert.ok(signals.some((s) => s.kind === 'trait' && s.name === '诚实'))
})

test('reflectReply 认出先接住她的话', () => {
  const signals = reflectReply('嗯，我在。先别急，我们一步步来。')
  assert.ok(signals.some((s) => s.kind === 'habit' && s.key === 'opening'))
})

test('reflectReply 不复述命令句（不给 tone 正向）', () => {
  const signals = reflectReply('你必须马上改，立刻执行。')
  assert.equal(signals.some((s) => s.key === 'tone'), false)
})

test('reflectTurn 给特质加一点强度，且不超每日上限', () => {
  return withDb((db) => {
    const first = reflectTurn({ db, text: '我不确定这个行不行。', messageId: 'm1' })
    assert.ok(first.some((line) => line.startsWith('诚实')))
    let trait = listTraits(db).find((t) => t.name === '诚实')
    assert.ok(Math.abs(Number(trait.strength) - 0.18) < 1e-6)

    for (let i = 0; i < 20; i += 1) reflectTurn({ db, text: '我不确定。', messageId: `m${i + 2}` })
    trait = listTraits(db).find((t) => t.name === '诚实')
    assert.ok(Number(trait.strength) <= 0.15 + 0.1 + 1e-6)
  })
})

test('reflectTurn 让说话习惯也长', () => {
  return withDb((db) => {
    reflectTurn({ db, text: '嗯，我在。', messageId: 'm1' })
    const habit = listHabits(db, { includeRetired: true }).find((h) => h.key === 'opening')
    assert.ok(habit)
    assert.ok(Number(habit.strength) > 0.15)
  })
})

test('behaviorLine 只在特质稳定后出现', () => {
  return withDb((db) => {
    assert.equal(behaviorLine(db), '')
    observeTrait(db, { name: '诚实', delta: 0.1, behavior: '不确定就说不知道', evidence: ['b1'] })
    assert.equal(behaviorLine(db), '')
    // push it over the active threshold
    for (let i = 0; i < 4; i += 1) {
      const now = Date.now() + (i + 1) * 24 * 3600 * 1000
      observeTrait(db, { name: '诚实', delta: 0.1, behavior: '不确定就说不知道', evidence: [`b${i + 2}`] }, now)
    }
    const line = behaviorLine(db)
    assert.match(line, /诚实：不确定就说不知道/)
  })
})

test('reflectTurn 遇到空文本不炸', () => {
  return withDb((db) => {
    assert.deepEqual(reflectTurn({ db, text: '' }), [])
    assert.deepEqual(reflectTurn({ db, text: '   ' }), [])
  })
})
