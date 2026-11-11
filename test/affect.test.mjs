import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase, closeDatabase } from '../lib/db.js'
import {
  labelFor,
  normalizeAppraisal,
  deriveEmotion,
  recordEmotion,
  currentMood,
  recentEmotions,
  decayMood,
  BASELINE,
} from '../lib/affect.js'
import { rememberBelief, listBeliefs, getBelief, setBeliefStatus } from '../lib/beliefs.js'

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'seed-affect-'))
  const db = openDatabase(join(dir, 'seed.db'))
  try {
    return fn(db, dir)
  } finally {
    closeDatabase(db)
    rmSync(dir, { recursive: true, force: true })
  }
}

function appr(over = {}) {
  return normalizeAppraisal({
    relevance: 0.7,
    congruence: 0.5,
    certainty: 0.8,
    control: 0.6,
    agency: 'other',
    novelty: 0.2,
    ...over,
  })
}

test('labelFor: positive and certain reads as 开心/安心, not 焦虑', () => {
  assert.equal(labelFor(appr({ congruence: 0.7, certainty: 0.9 }), 0.6, 0.7), '开心')
  assert.equal(labelFor(appr({ congruence: 0.5, certainty: 0.9 }), 0.4, 0.3), '安心')
  assert.equal(labelFor(appr({ congruence: 0.5, certainty: 0.4 }), 0.4, 0.5), '期待')
})

test('labelFor: negative, caused by her, uncontrollable reads as 生气; self reads as 自责', () => {
  assert.equal(labelFor(appr({ congruence: -0.7, control: 0.2, agency: 'other' }), -0.6, 0.7), '生气')
  assert.equal(labelFor(appr({ congruence: -0.7, control: 0.2, agency: 'self' }), -0.6, 0.6), '自责')
  assert.equal(labelFor(appr({ congruence: -0.4, control: 0.2, certainty: 0.3 }), -0.4, 0.6), '焦虑')
})

test('labelFor: irrelevant events stay 平静; surprising ones are 惊讶', () => {
  assert.equal(labelFor(appr({ relevance: 0.1, congruence: 0.8 }), 0.1, 0.3), '平静')
  assert.equal(labelFor(appr({ relevance: 0.2, congruence: 0.05, novelty: 0.9 }), 0, 0.5), '惊讶')
})

test('deriveEmotion fills valence/arousal/intensity and keeps signed congruence', () => {
  const d = deriveEmotion({ appraisal: { relevance: 0.9, congruence: -0.8, certainty: 0.5, control: 0.1, agency: 'other', novelty: 0.4 } })
  assert.equal(d.label, '生气')
  assert.ok(d.valence < 0)
  assert.ok(d.arousal > 0.3 && d.arousal <= 1)
  assert.ok(d.intensity > 0.3 && d.intensity <= 1)
  assert.equal(d.appraisal.congruence, -0.8)
})

test('recordEmotion writes an episode and nudges mood; strong emotion colours it', () => {
  withDb((db) => {
    const before = currentMood(db)
    assert.equal(before.line, '')

    const r = recordEmotion(db, {
      cause: '她说今晚没空陪我',
      appraisal: { relevance: 0.9, congruence: -0.7, certainty: 0.8, control: 0.2, agency: 'other', novelty: 0.1 },
    })
    assert.equal(r.label, '生气')
    const after = currentMood(db)
    assert.ok(after.valence < before.valence)
    assert.notEqual(after.line, '')
    assert.match(after.line, /^此刻：/)

    const rows = recentEmotions(db, 5)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].cause, '她说今晚没空陪我')
  })
})

test('mood decays back toward baseline over hours', () => {
  withDb((db) => {
    const now = Date.now()
    db.prepare('UPDATE mood SET valence = ?, arousal = ?, label = ?, cause = ?, updated_at = ? WHERE id = 1')
      .run(0.9, 0.8, '开心', null, now - 12 * 3600_000)

    const decayed = decayMood(
      { valence: 0.9, arousal: 0.8, label: '开心', cause: null, updated_at: now - 12 * 3600_000 },
      now
    )
    assert.ok(Math.abs(decayed.valence - (BASELINE.valence + (0.9 - BASELINE.valence) * 0.25)) < 1e-6)
    assert.ok(decayed.arousal < 0.8)
    assert.ok(decayed.arousal > BASELINE.arousal)
  })
})

test('beliefs: same factKey supersedes the old claim and keeps a trail', () => {
  withDb((db) => {
    const a = rememberBelief(db, { claim: '她不喜欢被催', factKey: '她.被催', confidence: 0.7 })
    const b = rememberBelief(db, { claim: '她其实可以接受提前说一声的提醒', factKey: '她.被催', confidence: 0.6 })
    assert.ok(b.superseded === a.id)

    const active = listBeliefs(db)
    assert.equal(active.length, 1)
    assert.equal(active[0].id, b.id)

    const old = getBelief(db, a.id)
    assert.equal(old.status, 'retired')
    assert.equal(old.superseded_by, b.id)
  })
})

test('beliefs: contested is excluded from active list but keeps claim', () => {
  withDb((db) => {
    const r = rememberBelief(db, { claim: '她喜欢惊喜', confidence: 0.4 })
    setBeliefStatus(db, r.id, 'contested')
    assert.equal(listBeliefs(db).length, 0)
    assert.equal(listBeliefs(db, { includeContested: true }).length, 1)
    assert.equal(listBeliefs(db, { includeContested: true })[0].status, 'contested')
    const row = getBelief(db, r.id)
    assert.equal(row.status, 'contested')
    assert.equal(row.claim, '她喜欢惊喜')
  })
})
