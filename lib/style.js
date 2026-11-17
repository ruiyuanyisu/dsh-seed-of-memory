import { randomBytes } from 'node:crypto'

export const ACTIVE_AT = 0.4
export const DAILY_CAP = 0.15
export const MAX_LINE = 80

const HABIT_KEYS = new Set([
  'tone', 'opening', 'length', 'punctuation', 'particles',
  'emoji', 'address', 'disagreement', 'humor', 'voice',
])

function nowMs(now) {
  if (now === undefined) return Date.now()
  return now instanceof Date ? now.getTime() : Number(now)
}

function dayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s，。！？、；：""''（）()【】[\]…—~·,.!?;:'"]+/g, '')
    .trim()
}

function newId() {
  return 'h_' + Date.now().toString(36) + randomBytes(3).toString('hex')
}

function parseJson(text, fallback) {
  try {
    const value = JSON.parse(text)
    return value ?? fallback
  } catch {
    return fallback
  }
}

function rowToHabit(row) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    statement: row.statement,
    strength: Number(row.strength),
    status: row.status,
    source: row.source,
    evidence: parseJson(row.evidence, []),
    counter: parseJson(row.counter, []),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at),
  }
}

export function listHabits(db, { limit = 50, includeRetired = false } = {}) {
  const rows = includeRetired
    ? db.prepare('SELECT * FROM habits ORDER BY strength DESC, updated_at DESC LIMIT ?').all(limit)
    : db.prepare("SELECT * FROM habits WHERE status != 'retired' ORDER BY strength DESC, updated_at DESC LIMIT ?").all(limit)
  return rows.map(rowToHabit)
}

export function getHabit(db, idOrPrefix) {
  if (!idOrPrefix) return null
  const raw = String(idOrPrefix)
  const direct = db.prepare('SELECT * FROM habits WHERE id = ?').get(raw)
  if (direct) return rowToHabit(direct)
  const row = db.prepare("SELECT * FROM habits WHERE id LIKE ? || '%' ORDER BY updated_at DESC LIMIT 1").get(raw)
  return row ? rowToHabit(row) : null
}

/**
 * Record one style observation. Positive delta grows a habit; negative marks a counter-example.
 * A habit only becomes visible in the injected style line once it reaches ACTIVE_AT.
 */
export function observeHabit(db, input = {}, now) {
  const ts = nowMs(now)
  const statement = String(input.statement ?? '').trim()
  if (!statement) throw new Error('statement is required')
  if (statement.length > 200) throw new Error('statement is too long (max 200)')

  const key = HABIT_KEYS.has(input.key) ? input.key : 'tone'
  const name = String(input.name ?? '').trim() || statement.slice(0, 12)
  // 这条习惯是「在谁面前」学到的（REVIEW-151 扩展建议 ⑦）。它不参与检索、
  // 也不影响注入 —— 只是留着，以后想按人分说话习惯时能看见来路。
  const learnedIn = String(input.scope ?? '').trim() || ''
  const norm = normalize(statement)
  const delta = Number.isFinite(Number(input.delta)) ? Number(input.delta) : 0.08
  const evidence = Array.isArray(input.evidence) ? input.evidence.filter(Boolean).map(String) : []
  const source = String(input.source ?? 'observed')

  const existing = db.prepare('SELECT * FROM habits WHERE norm = ?').get(norm)
  if (existing) {
    const meta = parseJson(existing.meta, {})
    const day = dayKey(ts)
    let dayGain = meta.dayGainDay === day ? Number(meta.dayGain ?? 0) : 0
    let applied = delta
    if (delta > 0) {
      const room = Math.max(0, DAILY_CAP - dayGain)
      applied = Math.min(delta, room)
      dayGain += applied
    }
    const strength = Math.max(0, Math.min(1, Number(existing.strength) + applied))
    const status = strength >= ACTIVE_AT ? 'active' : existing.status === 'retired' ? 'retired' : 'candidate'
    const nextEvidence = applied > 0
      ? [...parseJson(existing.evidence, []), ...evidence].filter(Boolean).slice(-50)
      : parseJson(existing.evidence, [])
    const nextCounter = applied < 0
      ? [...parseJson(existing.counter, []), ...(evidence.length ? evidence : [String(ts)])].filter(Boolean).slice(-50)
      : parseJson(existing.counter, [])

    db.prepare(`
      UPDATE habits
         SET strength = ?, status = ?, evidence = ?, counter = ?, source = ?,
             meta = ?, updated_at = ?, last_seen_at = ?
       WHERE id = ?
    `).run(
      strength,
      status,
      JSON.stringify(nextEvidence),
      JSON.stringify(nextCounter),
      source,
      JSON.stringify({ ...meta, dayGainDay: day, dayGain, ...(learnedIn && !meta.learnedIn ? { learnedIn } : {}) }),
      ts,
      ts,
      existing.id,
    )
    if (applied === 0) {
      return { ...rowToHabit(db.prepare('SELECT * FROM habits WHERE id = ?').get(existing.id)), applied: 0, capped: true }
    }
    return { ...rowToHabit(db.prepare('SELECT * FROM habits WHERE id = ?').get(existing.id)), applied }
  }

  const id = newId()
  const strength = Math.max(0, Math.min(1, 0.15 + delta))
  const status = strength >= ACTIVE_AT ? 'active' : 'candidate'
  db.prepare(`
    INSERT INTO habits (id, key, name, norm, statement, strength, evidence, counter, status, source, meta, created_at, updated_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    key,
    name,
    norm,
    statement,
    strength,
    JSON.stringify(evidence),
    status,
    source,
    JSON.stringify({ dayGainDay: dayKey(ts), dayGain: Math.max(0, delta), ...(learnedIn ? { learnedIn } : {}) }),
    ts,
    ts,
    ts,
  )
  return { ...rowToHabit(db.prepare('SELECT * FROM habits WHERE id = ?').get(id)), applied: delta }
}

/** Compact line for the prompt: only habits that have earned their place. */
export function styleLine(db) {
  const active = db.prepare("SELECT * FROM habits WHERE status = 'active' ORDER BY strength DESC, updated_at DESC LIMIT 3").all()
  if (active.length === 0) return ''
  let text = active.map((row) => row.statement).join('；')
  if (text.length > MAX_LINE) text = text.slice(0, MAX_LINE - 1) + '…'
  return text
}

export function styleSummary(db) {
  const all = listHabits(db, { limit: 40 })
  const active = all.filter((h) => h.status === 'active')
  const candidates = all.filter((h) => h.status === 'candidate')
  const lines = []
  lines.push(active.length ? '说话习惯：' + active.map((h) => `${h.statement}（${h.strength.toFixed(2)}）`).join('；') : '说话习惯：还没有定型的，先观察。')
  if (candidates.length) {
    lines.push('在学：' + candidates.slice(0, 6).map((h) => `${h.name} ${h.strength.toFixed(2)}`).join('、'))
  }
  return lines.join('\n')
}

/** Seed a couple of habits that already have evidence, so the card is not empty on first run. */
export function ensureDefaultHabits(db, now) {
  const ts = nowMs(now)
  const count = Number(db.prepare('SELECT COUNT(*) AS n FROM habits').get().n)
  if (count > 0) return 0
  const base = Date.parse('2026-11-03T10:00:00')
  const day2 = base + 24 * 60 * 60 * 1000
  const tone = {
    key: 'tone',
    name: '语气放软',
    statement: '把话说软一点，不用命令句',
    evidence: ['m_mwbnyt'],
    source: 'import',
  }
  // 旧记忆 2026-11-03 起就在学「把话讲得软一点」，按两天分两次记，正好到「已定型」。
  observeHabit(db, { ...tone, delta: 0.15 }, base)
  observeHabit(db, { ...tone, delta: 0.15 }, day2)
  observeHabit(db, {
    key: 'opening',
    name: '先接一句',
    statement: '先接住他的话，再展开自己的想法',
    delta: 0.06,
    source: 'inferred',
  }, ts)
  return 2
}
