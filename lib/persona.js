// Personality layer: traits that grow out of memories and beliefs, plus the
// aspiration they are measured against. Traits change slowly and every change
// must point at evidence — no unattributed self-praise.

import { randomUUID } from 'node:crypto'

export const DAY_MS = 24 * 60 * 60 * 1000
export const DAILY_CAP = 0.1
export const ACTIVE_AT = 0.35
export const DECAY_HALF_LIFE_DAYS = 90

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0))
const normOf = (text) => String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

function dayKey(ts) {
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function readJson(text, fallback) {
  try {
    const value = JSON.parse(text ?? '')
    return Array.isArray(fallback) ? (Array.isArray(value) ? value : fallback) : (value ?? fallback)
  } catch {
    return fallback
  }
}

export function getAspiration(db) {
  const row = db.prepare('SELECT * FROM aspiration WHERE id = 1').get()
  if (!row) return { statement: '', keywords: [], note: null, updated_at: null }
  return {
    statement: row.statement,
    keywords: readJson(row.keywords, []),
    note: row.note ?? null,
    updated_at: row.updated_at,
  }
}

export function setAspiration(db, { statement, keywords, note }, now = Date.now()) {
  const text = String(statement ?? '').trim()
  if (!text) throw new Error('理想不能是空的')
  const list = Array.isArray(keywords)
    ? keywords.map((item) => String(item).trim()).filter(Boolean)
    : String(keywords ?? '')
        .split(/[、,，/|\s]+/)
        .map((item) => item.trim())
        .filter(Boolean)
  db.prepare(
    `INSERT INTO aspiration (id, statement, keywords, note, updated_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET statement = excluded.statement,
       keywords = excluded.keywords, note = excluded.note, updated_at = excluded.updated_at`,
  ).run(text, JSON.stringify(list), note ? String(note).trim() : null, now)
  return getAspiration(db)
}

export function listTraits(db, { limit = 100, includeRetired = false } = {}) {
  const sql = includeRetired
    ? 'SELECT * FROM traits ORDER BY strength DESC, updated_at DESC LIMIT ?'
    : "SELECT * FROM traits WHERE status != 'retired' ORDER BY strength DESC, updated_at DESC LIMIT ?"
  return db.prepare(sql).all(Math.max(1, Math.min(500, Number(limit) || 100))).map((row) => ({
    id: row.id,
    name: row.name,
    statement: row.statement ?? null,
    kind: row.kind,
    strength: Number(row.strength),
    trend: row.trend,
    evidence: readJson(row.evidence, []),
    counter: readJson(row.counter, []),
    status: row.status,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    last_seen_at: row.last_seen_at ? Number(row.last_seen_at) : null,
  }))
}

/**
 * Observe a trait (positive) or a counter-example (negative).
 *
 * Growth is capped per calendar day so a single intense conversation cannot
 * rewrite the personality; evidence is appended so `seed_why` can trace it.
 */
export function observeTrait(db, input, now = Date.now()) {
  const name = String(input.name ?? '').trim()
  if (!name) throw new Error('特质名不能是空的')
  const norm = normOf(name)
  const delta = Number(input.delta ?? 0.08)
  if (!Number.isFinite(delta) || delta === 0) throw new Error('delta 必须是数字')
  const capped = Math.max(-DAILY_CAP, Math.min(DAILY_CAP, delta))

  const row = db.prepare('SELECT * FROM traits WHERE norm = ?').get(norm)
  if (!row) {
    const id = 't_' + randomUUID().replace(/-/g, '').slice(0, 10)
    const strength = clamp01(0.15 + Math.max(0, capped))
    db.prepare(
      `INSERT INTO traits (id, name, norm, statement, kind, strength, trend, evidence, counter, status, meta, created_at, updated_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      name,
      norm,
      input.statement ? String(input.statement).trim() : null,
      input.kind ?? 'temperament',
      strength,
      capped >= 0 ? 'up' : 'down',
      JSON.stringify(capped >= 0 ? (input.evidence ?? []) : []),
      JSON.stringify(capped < 0 ? (input.evidence ?? []) : []),
      strength >= ACTIVE_AT ? 'active' : 'candidate',
      JSON.stringify({ day: dayKey(now), delta: Math.abs(capped) }),
      now,
      now,
      capped >= 0 ? now : null,
    )
    return {
      created: true,
      trait: listTraits(db, { includeRetired: true }).find((item) => item.id === id),
      applied: capped,
    }
  }

  const meta = readJson(row.meta, {})
  const today = dayKey(now)
  const usedToday = meta.day === today ? Number(meta.delta) || 0 : 0
  const remaining = Math.max(0, DAILY_CAP - usedToday)
  const applied = Math.max(-remaining, Math.min(remaining, capped))

  const evidence = readJson(row.evidence, [])
  const counter = readJson(row.counter, [])
  for (const id of input.evidence ?? []) {
    if (!id) continue
    const bucket = applied >= 0 ? evidence : counter
    if (!bucket.includes(id)) bucket.push(id)
  }

  const nextStrength = clamp01(Number(row.strength) + applied)
  let status = row.status
  if (nextStrength >= ACTIVE_AT && status !== 'retired') status = 'active'
  else if (nextStrength < ACTIVE_AT) status = 'candidate'

  db.prepare(
    `UPDATE traits SET strength = ?, trend = ?, evidence = ?, counter = ?, status = ?,
       statement = COALESCE(?, statement), meta = ?, updated_at = ?, last_seen_at = ?
     WHERE id = ?`,
  ).run(
    nextStrength,
    applied > 0 ? 'up' : applied < 0 ? 'down' : 'flat',
    JSON.stringify(evidence),
    JSON.stringify(counter),
    status,
    input.statement ? String(input.statement).trim() : null,
    JSON.stringify({ day: today, delta: usedToday + Math.abs(applied) }),
    now,
    applied >= 0 ? now : row.last_seen_at,
    row.id,
  )

  return {
    created: false,
    trait: listTraits(db, { includeRetired: true }).find((item) => item.id === row.id),
    applied,
    capped: applied !== capped,
  }
}

/** Slow forgetting: unused traits fade with a 90-day half-life. */
export function decayTraits(db, now = Date.now()) {
  const rows = db.prepare("SELECT * FROM traits WHERE status != 'retired'").all()
  let changed = 0
  for (const row of rows) {
    const anchor = Number(row.last_seen_at ?? row.updated_at ?? now)
    const days = (now - anchor) / DAY_MS
    if (days < 14) continue
    const next = clamp01(Number(row.strength) * Math.pow(0.5, days / DECAY_HALF_LIFE_DAYS))
    if (Math.abs(next - Number(row.strength)) < 0.005) continue
    db.prepare('UPDATE traits SET strength = ?, trend = ?, updated_at = ? WHERE id = ?').run(
      next,
      'down',
      now,
      row.id,
    )
    changed += 1
  }
  return changed
}

/**
 * Fit between the aspiration and the traits that exist: each keyword asks for
 * the strongest trait carrying it; missing or weak keywords become "gaps".
 */
export function fitScore(traits, aspiration) {
  const keywords = aspiration?.keywords ?? []
  if (!keywords.length) return { score: 0, parts: [], gaps: [] }
  const parts = keywords.map((keyword) => {
    const matching = traits.filter(
      (trait) =>
        trait.status !== 'retired' &&
        (trait.name.includes(keyword) || (trait.statement ?? '').includes(keyword) || keyword.includes(trait.name)),
    )
    const best = matching.reduce((acc, trait) => Math.max(acc, trait.strength), 0)
    return { keyword, strength: Number(best.toFixed(2)), missing: matching.length === 0 }
  })
  const score = parts.reduce((acc, part) => acc + part.strength, 0) / parts.length
  const gaps = parts.filter((part) => part.strength < 0.4).map((part) => part.keyword)
  return { score: Number(score.toFixed(2)), parts, gaps }
}

/** One short line for the per-turn card (≤ 90 chars). */
export function personaLine(db) {
  const all = listTraits(db, { limit: 20 })
  const active = all.filter((trait) => trait.status === 'active')
  if (!active.length) {
    const candidates = all.filter((trait) => trait.status === 'candidate').slice(0, 3)
    if (!candidates.length) return ''
    const line = `性格（候选）：${candidates.map((trait) => trait.name).join('、')}`
    return line.length <= 90 ? line : line.slice(0, 89) + '…'
  }
  const top = active.slice(0, 3)
  const growing = active.find((trait) => trait.trend === 'up' && trait.strength < 0.7 && !top.includes(trait))
  const head = `性格：${top.map((trait) => trait.name).join('、')}`
  const tail = growing ? `（在长：${growing.name}）` : ''
  const line = head + tail
  return line.length <= 90 ? line : line.slice(0, 89) + '…'
}

export function personaSummary(db) {
  const aspiration = getAspiration(db)
  const traits = listTraits(db, { limit: 30 })
  const active = traits.filter((trait) => trait.status === 'active')
  const fit = fitScore(traits, aspiration)
  const lines = []
  lines.push(`理想：${aspiration.statement || '（还没写）'}`)
  if (aspiration.keywords.length) {
    const parts = fit.parts.map((part) => `${part.keyword} ${part.strength.toFixed(2)}`).join(' · ')
    lines.push(`拟合度：${(fit.score * 100).toFixed(0)}%（${parts}）`)
    if (fit.gaps.length) lines.push(`还差：${fit.gaps.join('、')}`)
  }
  if (active.length) {
    lines.push('正在长成的特质：')
    for (const trait of active.slice(0, 8)) {
      const arrow = trait.trend === 'up' ? '↗' : trait.trend === 'down' ? '↘' : '→'
      lines.push(`- ${trait.name} ${trait.strength.toFixed(2)} ${arrow}（证据 ${trait.evidence.length}）`)
    }
  } else {
    lines.push('还没有稳定的特质，先观察。')
  }
  const candidates = traits.filter((trait) => trait.status === 'candidate')
  if (candidates.length) {
    lines.push(`候选：${candidates.slice(0, 6).map((trait) => `${trait.name} ${trait.strength.toFixed(2)}`).join('、')}`)
  }
  return lines.join('\n')
}
