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
  ensureAffects,
  listAffects,
  affectLine,
  decayAffects,
  AFFECT_BASE,
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
    const r = rememberBelief(db, { claim: '他喜欢惊喜', confidence: 0.4 })
    setBeliefStatus(db, r.id, 'contested')
    assert.equal(listBeliefs(db).length, 0)
    assert.equal(listBeliefs(db, { includeContested: true }).length, 1)
    assert.equal(listBeliefs(db, { includeContested: true })[0].status, 'contested')
    const row = getBelief(db, r.id)
    assert.equal(row.status, 'contested')
    assert.equal(row.claim, '他喜欢惊喜')
  })
})

test('affects: seeded with four kinds at their base strengths', () => {
  withDb((db) => {
    ensureAffects(db)
    const rows = listAffects(db)
    assert.deepEqual(rows.map((row) => row.kind), ['信任', '亲近', '欣赏', '依恋'])
    for (const row of rows) {
      assert.ok(Math.abs(row.strength - AFFECT_BASE[row.kind]) < 1e-9)
    }
    assert.equal(affectLine(db).line, '')
  })
})

test('affects: a strong positive emotion raises trust and closeness, and shows up in the line', () => {
  withDb((db) => {
    const r = recordEmotion(db, {
      cause: '他夸我把分层讲清楚了',
      object: '他',
      appraisal: { relevance: 0.9, congruence: 0.8, certainty: 0.9, control: 0.6, agency: 'other', novelty: 0.2 },
    })
    assert.equal(r.object, '他')
    assert.ok(Array.isArray(r.affects) && r.affects.length >= 2)
    const rows = listAffects(db)
    const trust = rows.find((row) => row.kind === '信任')
    const closeness = rows.find((row) => row.kind === '亲近')
    assert.ok(trust.strength > AFFECT_BASE['信任'])
    assert.ok(closeness.strength > AFFECT_BASE['亲近'])
    const line = affectLine(db).line
    assert.match(line, /^对你：/)
    assert.match(line, /信任/)
  })
})

test('affects: a negative emotion lowers trust but never below the floor', () => {
  withDb((db) => {
    for (let i = 0; i < 30; i += 1) {
      recordEmotion(db, {
        cause: `第 ${i} 次失望`,
        appraisal: { relevance: 0.9, congruence: -0.9, certainty: 0.9, control: 0.2, agency: 'other', novelty: 0.1 },
      })
    }
    const trust = listAffects(db).find((row) => row.kind === '信任')
    assert.ok(trust.strength >= 0.02)
    assert.ok(trust.strength < AFFECT_BASE['信任'])
  })
})

test('affects: decay pulls a moved value back toward its base', () => {
  withDb((db) => {
    const now = Date.now()
    ensureAffects(db, '他', now)
    db.prepare(
      "UPDATE affects SET strength = 0.9, updated_at = ? WHERE target = '他' AND kind = '信任'"
    ).run(now - 30 * 86_400_000)
    decayAffects(db, { now })
    const trust = listAffects(db, { now }).find((row) => row.kind === '信任')
    assert.ok(trust.strength < 0.75 && trust.strength > AFFECT_BASE['信任'])
  })
})

test('emotions/affects are per-slot: 别人惹我不高兴，不该动到我对老大的信任', () => {
  withDb((db) => {
    const annoyed = {
      cause: 'QQ 上那个人一直催',
      appraisal: { relevance: 0.9, congruence: -0.9, certainty: 0.9, control: 0.2, agency: 'other', novelty: 0.1 },
    }
    for (let i = 0; i < 10; i += 1) recordEmotion(db, { ...annoyed, slot: 'qq:10001' }, Date.now() + i)

    const trustGui = listAffects(db).find((row) => row.kind === '信任')
    const trustHis = listAffects(db, { slot: 'qq:10001' }).find((row) => row.kind === '信任')
    assert.equal(trustGui.strength, AFFECT_BASE['信任'], '对老大的信任不该被别人的事拖下去')
    assert.ok(trustHis.strength < AFFECT_BASE['信任'], '对他自己那份账该降')

    // 情绪条目也分档：当面看不见 QQ 上那条
    assert.equal(recentEmotions(db, 20, 'gui').length, 0)
    assert.equal(recentEmotions(db, 20, 'qq:10001').length, 10)
    assert.equal(recentEmotions(db, 20, 'qq:20002').length, 0)
    // 心情是我一个人的：不管谁惹的，它都动
    assert.ok(currentMood(db).line.length > 0 || currentMood(db).valence < BASELINE.valence)
  })
})
