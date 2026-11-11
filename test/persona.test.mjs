import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase, closeDatabase } from '../lib/db.js'
import {
  getAspiration,
  setAspiration,
  listTraits,
  observeTrait,
  decayTraits,
  fitScore,
  personaLine,
  personaSummary,
  DAILY_CAP,
  DAY_MS,
} from '../lib/persona.js'

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'seed-persona-'))
  const db = openDatabase(join(dir, 'seed.db'))
  try {
    return fn(db)
  } finally {
    closeDatabase(db)
    rmSync(dir, { recursive: true, force: true })
  }
}

test('aspiration round-trips with keywords', () => {
  withDb((db) => {
    assert.equal(getAspiration(db).statement, '')
    setAspiration(db, { statement: '可爱温柔带点任性', keywords: ['可爱', '温柔', '任性'] })
    const next = getAspiration(db)
    assert.equal(next.statement, '可爱温柔带点任性')
    assert.deepEqual(next.keywords, ['可爱', '温柔', '任性'])
    assert.throws(() => setAspiration(db, { statement: '  ' }))
  })
})

test('a trait starts as candidate and grows to active', () => {
  withDb((db) => {
    const first = observeTrait(db, { name: '温柔', evidence: ['m1'] }, 1_700_000_000_000)
    assert.equal(first.created, true)
    assert.equal(first.trait.status, 'candidate')
    assert.ok(Math.abs(first.trait.strength - 0.23) < 1e-9, String(first.trait.strength))

    // next day (cap reset) grows a bit more; the third push crosses the threshold
    const second = observeTrait(db, { name: '温柔', evidence: ['m2'] }, 1_700_000_000_000 + DAY_MS)
    assert.equal(second.trait.status, 'candidate')
    const third = observeTrait(db, { name: '温柔', evidence: ['m3'] }, 1_700_000_000_000 + 2 * DAY_MS)
    assert.equal(third.trait.status, 'active')
    assert.ok(third.trait.strength >= 0.35)
    assert.deepEqual(third.trait.evidence, ['m1', 'm2', 'm3'])
    assert.equal(third.trait.trend, 'up')
  })
})

test('daily growth is capped at 0.1 per trait', () => {
  withDb((db) => {
    const now = 1_700_000_000_000
    observeTrait(db, { name: '诚实', delta: 0.08 }, now)
    const second = observeTrait(db, { name: '诚实', delta: 0.08 }, now + 60_000)
    assert.equal(second.capped, true)
    assert.ok(Math.abs(second.applied - 0.02) < 1e-6)
    const trait = listTraits(db).find((row) => row.name === '诚实')
    assert.ok(Math.abs(trait.strength - (0.15 + DAILY_CAP)) < 1e-6)
  })
})

test('counter-examples lower strength and are recorded separately', () => {
  withDb((db) => {
    const now = 1_700_000_000_000
    observeTrait(db, { name: '抢话', delta: 0.08, evidence: ['m1'] }, now)
    const before = listTraits(db).find((row) => row.name === '抢话').strength
    const down = observeTrait(db, { name: '抢话', delta: -0.05, evidence: ['m2'] }, now + DAY_MS)
    assert.ok(down.trait.strength < before)
    assert.equal(down.trait.trend, 'down')
    assert.deepEqual(down.trait.counter, ['m2'])
  })
})

test('unused traits decay with a 90-day half-life', () => {
  withDb((db) => {
    const now = 1_700_000_000_000
    observeTrait(db, { name: '好奇', delta: 0.5 }, now)
    const start = listTraits(db).find((row) => row.name === '好奇').strength
    // pretend it has been untouched for 180 days
    db.prepare('UPDATE traits SET last_seen_at = ? WHERE name = ?').run(now - 180 * DAY_MS, '好奇')
    const changed = decayTraits(db, now)
    assert.equal(changed, 1)
    const after = listTraits(db).find((row) => row.name === '好奇').strength
    assert.ok(Math.abs(after - start * 0.25) < 0.02, `expected quarter, got ${after}`)
  })
})

test('fit score averages keyword strengths and reports gaps', () => {
  const traits = [
    { name: '温柔', statement: null, strength: 0.8, status: 'active' },
    { name: '有点任性', statement: null, strength: 0.2, status: 'active' },
  ]
  const fit = fitScore(traits, { keywords: ['可爱', '温柔', '任性'] })
  assert.equal(fit.parts.length, 3)
  assert.equal(fit.parts[0].strength, 0)
  assert.equal(fit.parts[1].strength, 0.8)
  assert.equal(fit.parts[2].strength, 0.2)
  assert.ok(Math.abs(fit.score - 0.33) < 1e-9, String(fit.score))
  assert.deepEqual(fit.gaps, ['可爱', '任性'])
})

test('persona line stays short and persona summary mentions the ideal', () => {
  withDb((db) => {
    const now = 1_700_000_000_000
    setAspiration(db, { statement: '可爱温柔带点任性', keywords: ['可爱', '温柔', '任性'] })
    for (const name of ['温柔', '诚实', '好奇']) {
      for (let i = 0; i < 3; i += 1) observeTrait(db, { name }, now + i * DAY_MS)
    }
    const line = personaLine(db)
    assert.ok(line.startsWith('性格：'))
    assert.ok(line.length <= 90, line)
    const summary = personaSummary(db)
    assert.ok(summary.includes('理想：可爱温柔带点任性'))
    assert.ok(summary.includes('拟合度'))
    assert.ok(summary.includes('温柔'))
  })
})
