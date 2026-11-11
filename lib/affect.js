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
  db.prepare(
    `INSERT INTO emotions (id, label, valence, arousal, intensity, cause, belief_id, memory_id, appraisal, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

  return { id, ...derived, mood: { valence: nextValence, arousal: nextArousal, label: derived.label } }
}

export function currentMood(db, now = Date.now()) {
  const row = db.prepare('SELECT valence, arousal, label, cause, updated_at FROM mood WHERE id = 1').get()
  return describeMood(row, now)
}

export function recentEmotions(db, limit = 5) {
  return db
    .prepare('SELECT id, label, valence, arousal, intensity, cause, created_at FROM emotions ORDER BY created_at DESC LIMIT ?')
    .all(Math.max(1, Math.min(50, Number(limit) || 5)))
}
