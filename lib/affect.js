/**
 * Affect layer: deterministic appraisal -> emotion, and a slowly decaying mood.
 *
 * The point is not to "perform" feelings. It is to give the agent a stable,
 * inspectable weighting signal that memory cards and recall can use:
 *   event -> appraisal(relevance, congruence, certainty, control, agency, novelty)
 *         -> emotion(valence, arousal, label, intensity)
 *         -> mood (decayed aggregate, a single row)
 *
 * No model call happens here. If the model wants to record how something felt,
 * it supplies the appraisal; we turn that into a label and numbers, and the
 * mood row moves a little.
 */
import { randomBytes } from 'node:crypto'

export const DIMS = [
  'relevance',
  'congruence',
  'certainty',
  'control',
  'agency',
  'novelty',
]

export const BASELINE = { valence: 0.1, arousal: 0.3 }
export const MOOD_HALF_LIFE_HOURS = 6

// 情绪词 → 效价（-1..1）。只用于召回偏置：同向的记忆在对应心情下更容易被想起。
const EMOTION_VALENCE = {
  开心: 0.8,
  安心: 0.5,
  期待: 0.45,
  惊讶: 0.1,
  平静: 0,
  难过: -0.6,
  生气: -0.55,
  自责: -0.65,
  焦虑: -0.5,
}

export function emotionValence(label) {
  if (!label) return null
  const key = String(label).trim()
  return Object.prototype.hasOwnProperty.call(EMOTION_VALENCE, key) ? EMOTION_VALENCE[key] : null
}

const HOUR = 3_600_000

function clamp(n, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}

export function newEmotionId(now = Date.now()) {
  return `e_${now.toString(36)}${randomBytes(3).toString('hex')}`
}

export function normalizeAppraisal(input = {}) {
  const out = {}
  for (const dim of DIMS) {
    if (dim === 'congruence' || dim === 'agency') continue
    out[dim] = clamp(input[dim] ?? 0.5, 0, 1)
  }
  // congruence is signed: -1 (against my goals) .. +1 (towards them)
  out.congruence = clamp(input.congruence ?? 0, -1, 1)
  // agency: who caused it — 'self' | 'other' | 'world'
  out.agency = ['self', 'other', 'world'].includes(input.agency) ? input.agency : 'world'
  return out
}

/**
 * OCC-flavoured rules. Deliberately small and legible, so the label can always
 * be traced back to the numbers: no black box, no second model.
 */
export function labelFor(appraisal, valence, arousal) {
  const { relevance, congruence, certainty, control, agency, novelty } = appraisal
  const impact = Math.abs(congruence) * relevance

  if (relevance < 0.25 || impact < 0.12) {
    if (novelty >= 0.6) return '惊讶'
    return '平静'
  }
  if (congruence >= 0.25) {
    if (certainty >= 0.6) return arousal >= 0.55 ? '开心' : '安心'
    if (certainty < 0.6) return '期待'
    return '开心'
  }
  if (congruence <= -0.25) {
    if (control < 0.35 && certainty < 0.5) return '焦虑'
    if (agency === 'other' && control < 0.45) return '生气'
    if (agency === 'self' && control < 0.45) return '自责'
    return '难过'
  }
  return novelty >= 0.6 ? '惊讶' : '平静'
}

export function deriveEmotion(input = {}) {
  const appraisal = normalizeAppraisal(input.appraisal ?? input)
  const rel = appraisal.relevance
  const cong = appraisal.congruence

  const valence = input.valence != null ? clamp(input.valence, -1, 1) : clamp(cong * 0.9, -1, 1)
  const baseArousal =
    0.25 + 0.35 * rel + 0.25 * Math.abs(cong) + 0.15 * (1 - appraisal.certainty)
  const arousal = input.arousal != null ? clamp(input.arousal, 0, 1) : clamp(baseArousal, 0, 1)
  const intensity =
    input.intensity != null
      ? clamp(input.intensity, 0, 1)
      : clamp(0.35 * rel + 0.35 * Math.abs(cong) + 0.3 * arousal, 0, 1)

  const label = String(input.label ?? input.emotion ?? '').trim() ||
    labelFor(appraisal, valence, arousal)

  return { label, valence, arousal, intensity, appraisal }
}

export function decayValue(value, baseline, ageMs) {
  if (ageMs <= 0) return value
  const halfLife = MOOD_HALF_LIFE_HOURS * HOUR
  const factor = Math.pow(0.5, ageMs / halfLife)
  return baseline + (value - baseline) * factor
}

export function decayMood(row, now = Date.now()) {
  const updated = Number(row?.updated_at ?? 0)
  const age = updated > 0 ? now - updated : 0
  return {
    valence: clamp(decayValue(row?.valence ?? BASELINE.valence, BASELINE.valence, age), -1, 1),
    arousal: clamp(decayValue(row?.arousal ?? BASELINE.arousal, BASELINE.arousal, age), 0, 1),
    label: row?.label ?? '平静',
    cause: row?.cause ?? null,
    updated_at: now,
  }
}

export function describeMood(row, now = Date.now()) {
  const mood = decayMood(row, now)
  const quiet = Math.abs(mood.valence) < 0.12 && mood.arousal < 0.45
  if (quiet) return { ...mood, line: '' }
  const v = mood.valence >= 0 ? `+${mood.valence.toFixed(2)}` : mood.valence.toFixed(2)
  const cause = mood.cause ? `，因为${mood.cause}` : ''
  const line = `此刻：${mood.label}（愉悦 ${v}，唤醒 ${mood.arousal.toFixed(2)}${cause}）`
  return { ...mood, line: Array.from(line).length > 80 ? Array.from(line).slice(0, 79).join('') + '…' : line }
}

/**
 * Persist one emotion episode and nudge the mood row.
 * Mood moves slowly: a single event can colour it, but cannot overwrite it.
 */
export function recordEmotion(db, input = {}, now = Date.now()) {
  const derived = deriveEmotion(input)
  const id = newEmotionId(now)
  const object = input.object != null ? String(input.object) : null
  db.prepare(
    `INSERT INTO emotions (id, label, valence, arousal, intensity, cause, belief_id, memory_id, appraisal, object, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    derived.label,
    derived.valence,
    derived.arousal,
    derived.intensity,
    input.cause != null ? String(input.cause) : null,
    input.beliefId != null ? String(input.beliefId) : null,
    input.memoryId != null ? String(input.memoryId) : null,
    JSON.stringify(derived.appraisal),
    object,
    now
  )

  const prev = db.prepare('SELECT valence, arousal, label, cause, updated_at FROM mood WHERE id = 1').get()
  const calm = decayMood(prev, now)
  const weight = 0.25 + 0.35 * derived.intensity
  const nextValence = clamp(calm.valence * (1 - weight) + derived.valence * weight, -1, 1)
  const nextArousal = clamp(calm.arousal * (1 - weight) + derived.arousal * weight, 0, 1)
  const cause = input.cause != null ? String(input.cause) : calm.cause

  db.prepare(
    'UPDATE mood SET valence = ?, arousal = ?, label = ?, cause = ?, updated_at = ? WHERE id = 1'
  ).run(nextValence, nextArousal, derived.label, cause, now)

  const affects = applyEmotionAffects(
    db,
    { valence: derived.valence, intensity: derived.intensity, cause },
    now
  )

  return {
    id,
    ...derived,
    object,
    mood: { valence: nextValence, arousal: nextArousal, label: derived.label },
    affects,
  }
}

export function currentMood(db, now = Date.now()) {
  const row = db.prepare('SELECT valence, arousal, label, cause, updated_at FROM mood WHERE id = 1').get()
  return describeMood(row, now)
}

export function recentEmotions(db, limit = 5) {
  return db
    .prepare(
      'SELECT id, label, valence, arousal, intensity, cause, object, created_at FROM emotions ORDER BY created_at DESC LIMIT ?'
    )
    .all(Math.max(1, Math.min(50, Number(limit) || 5)))
}

// ---------------------------------------------------------------------------
// Affects: slow relationship state towards him (not a mood, not a trait).
// trust / closeness / admiration / attachment, each 0..1, decaying to a base.
// ---------------------------------------------------------------------------

export const AFFECT_KINDS = ['信任', '亲近', '欣赏', '依恋']

export const AFFECT_BASE = {
  信任: 0.45,
  亲近: 0.4,
  欣赏: 0.35,
  依恋: 0.3,
}

export const AFFECT_HALF_LIFE_DAYS = 30
const DAY = 86_400_000

function newAffectId(now) {
  return `a_${now.toString(36)}${randomBytes(3).toString('hex')}`
}

function decayAffectStrength(strength, kind, ageMs) {
  const base = AFFECT_BASE[kind] ?? 0.3
  if (ageMs <= 0) return strength
  const factor = Math.pow(0.5, ageMs / (AFFECT_HALF_LIFE_DAYS * DAY))
  return base + (strength - base) * factor
}

export function ensureAffects(db, target = '他', now = Date.now()) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO affects (id, target, kind, strength, evidence, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
  for (const kind of AFFECT_KINDS) {
    insert.run(newAffectId(now), target, kind, AFFECT_BASE[kind], '[]', now)
  }
}

export function listAffects(db, { target = '他', now = Date.now() } = {}) {
  ensureAffects(db, target, now)
  return db
    .prepare('SELECT id, kind, strength, evidence, updated_at FROM affects WHERE target = ?')
    .all(target)
    .map((row) => {
      const age = now - Number(row.updated_at || now)
      let evidence = []
      try {
        evidence = JSON.parse(row.evidence || '[]')
      } catch {}
      return {
        id: row.id,
        kind: row.kind,
        strength: clamp(decayAffectStrength(row.strength, row.kind, age), 0, 1),
        base: AFFECT_BASE[row.kind] ?? 0.3,
        evidence,
        updatedAt: row.updated_at,
      }
    })
    .sort((a, b) => AFFECT_KINDS.indexOf(a.kind) - AFFECT_KINDS.indexOf(b.kind))
}

export function moveAffect(db, { target = '他', kind, delta = 0, evidence = null }, now = Date.now()) {
  if (!AFFECT_KINDS.includes(kind)) throw new Error(`unknown affect: ${kind}`)
  ensureAffects(db, target, now)
  const row = db.prepare('SELECT strength, evidence, updated_at FROM affects WHERE target = ? AND kind = ?').get(target, kind)
  const age = now - Number(row?.updated_at || now)
  const current = decayAffectStrength(clamp(row?.strength ?? AFFECT_BASE[kind], 0, 1), kind, age)
  const next = clamp(current + Number(delta || 0), 0.02, 0.98)
  let list = []
  try {
    list = JSON.parse(row?.evidence || '[]')
  } catch {}
  if (evidence) list = [String(evidence).slice(0, 80), ...list].slice(0, 12)
  db.prepare(
    'UPDATE affects SET strength = ?, evidence = ?, updated_at = ? WHERE target = ? AND kind = ?'
  ).run(next, JSON.stringify(list), now, target, kind)
  return { kind, strength: next, base: AFFECT_BASE[kind], evidence: list }
}

/**
 * An emotion about him moves the relationship state a little.
 * Only strong, clear events move it; nothing here rewrites facts or identity.
 */
export function applyEmotionAffects(db, { valence = 0, intensity = 0, cause = null } = {}, now = Date.now()) {
  const impact = Math.abs(valence) * clamp(intensity, 0, 1)
  if (impact < 0.2) return []
  const note = cause ? String(cause).slice(0, 60) : null
  const moved = []
  if (valence > 0) {
    moved.push(moveAffect(db, { kind: '信任', delta: 0.07 * impact, evidence: note }, now))
    moved.push(moveAffect(db, { kind: '亲近', delta: 0.05 * impact, evidence: note }, now))
    const closeness = listAffects(db, { now }).find((row) => row.kind === '亲近')
    if (closeness && closeness.strength >= 0.6) {
      moved.push(moveAffect(db, { kind: '依恋', delta: 0.02 * impact, evidence: note }, now))
    }
  } else {
    moved.push(moveAffect(db, { kind: '信任', delta: -0.06 * impact, evidence: note }, now))
    moved.push(moveAffect(db, { kind: '亲近', delta: -0.03 * impact, evidence: note }, now))
  }
  return moved
}

export function decayAffects(db, { target = '他', now = Date.now() } = {}) {
  ensureAffects(db, target, now)
  const rows = db
    .prepare('SELECT id, kind, strength, updated_at FROM affects WHERE target = ?')
    .all(target)
  for (const row of rows) {
    const age = now - Number(row.updated_at || now)
    if (age < 6 * 3_600_000) continue
    const next = decayAffectStrength(row.strength, row.kind, age)
    db.prepare('UPDATE affects SET strength = ?, updated_at = ? WHERE id = ?').run(next, now, row.id)
  }
}

export function affectLine(db, { target = '他', budget = 48, minDelta = 0.03, now = Date.now() } = {}) {
  const rows = listAffects(db, { target, now })
  const shown = rows.filter((row) => Math.abs(row.strength - row.base) >= minDelta)
  if (!shown.length) return { line: '', affects: rows }
  let line = shown.map((row) => `${row.kind} ${row.strength.toFixed(2)}`).join('、')
  line = `对你：${line}`
  if (Array.from(line).length > budget) line = Array.from(line).slice(0, budget - 1).join('') + '…'
  return { line, affects: rows }
}

