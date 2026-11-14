// Auto-capture: turn a user message into at most a couple of "maybe worth remembering" candidates.
// It never writes memories by itself — it only queues proposals, and the agent (or the panel) decides.

import { randomBytes } from 'node:crypto'
import { normalizeText, truncateChars, similarity } from './store.js'

export const MAX_PENDING = 20
export const EXPIRE_DAYS = 3
export const KNOWN_THRESHOLD = 0.55
export const PENDING_THRESHOLD = 0.7
export const MATCH_THRESHOLD = 0.6

const CUES = [
  { key: 'remember', re: /(记住|别忘了|别忘记|记一下|要记得)/ },
  { key: 'habit', re: /(每次都|总是|从来不|一向|我习惯|我一般|我通常|我每天|我经常)/ },
  { key: 'preference', re: /(我喜欢|我不喜欢|我讨厌|我最喜欢|我受不了|我爱看|我爱听|我不想)/ },
  { key: 'agreement', re: /(说好了|约定|答应我|以后都|以后不要|别再|不许|不准|一定要)/ },
  { key: 'identity', re: /(我叫|我的名字|我的生日|叫我|我住在|我是做)/ },
  { key: 'boundary', re: /(别碰|不要提|别提|不想聊|别问我|不要问)/ },
  { key: 'emotion', re: /(我害怕|我在意|我难过|我生气|我开心|我很累|我焦虑|我担心)/ },
]

function newId(now = Date.now()) {
  return `c_${now.toString(36)}${randomBytes(3).toString('hex')}`
}

function splitSentences(text) {
  return String(text)
    .split(/[。！？!?；;\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function cueOf(sentence) {
  for (const cue of CUES) {
    if (cue.re.test(sentence)) return cue.key
  }
  return null
}

/** Pull at most `max` candidate sentences that carry a memory-worthy cue. */
export function extractCandidates(text, { max = 3 } = {}) {
  const out = []
  const seen = new Set()
  for (const sentence of splitSentences(text)) {
    const clean = sentence.replace(/^[-*•\s]+/, '').trim()
    // 「记住：」「帮我记一下，」这类开头只是提示我该记，不是这件事本身——留下来的记忆不该带着它。
    const body = clean.replace(/^(?:帮我|给我)?(?:记住|记一下|记下)[：:，,、\s]*/, '').trim()
    if (body.length < 6 || body.length > 160) continue
    const cue = cueOf(clean)
    if (!cue) continue
    const norm = normalizeText(body)
    if (!norm || seen.has(norm)) continue
    seen.add(norm)
    out.push({ text: body, cue })
    if (out.length >= max) break
  }
  return out
}

function activeMemories(db, limit = 500) {
  try {
    return db
      .prepare(`SELECT id, text FROM memories WHERE status = 'active' ORDER BY recorded_at DESC LIMIT ?`)
      .all(limit)
  } catch {
    return []
  }
}

/** The active memory that already says (almost) the same thing, if any. */
export function findKnown(db, text, threshold = KNOWN_THRESHOLD) {
  const norm = normalizeText(text)
  if (!norm) return null
  for (const row of activeMemories(db)) {
    if (similarity(norm, normalizeText(row.text)) >= threshold) return row
  }
  return null
}

/** True when an active memory already says (almost) the same thing. */
export function isKnown(db, text, threshold = KNOWN_THRESHOLD) {
  if (!normalizeText(text)) return true
  return findKnown(db, text, threshold) !== null
}

export function listCaptures(db, { status = 'pending', limit = 20 } = {}) {
  if (status === 'all') {
    return db.prepare(`SELECT * FROM captures ORDER BY created_at DESC LIMIT ?`).all(limit)
  }
  return db
    .prepare(`SELECT * FROM captures WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
    .all(status, limit)
}

export function getCapture(db, id) {
  if (!id) return null
  return db.prepare(`SELECT * FROM captures WHERE id = ?`).get(id) ?? null
}

/** Queue one candidate; returns null when it is a duplicate. */
export function addCapture(db, { sessionId = '', text, cue = 'new', now = Date.now() }) {
  const clean = truncateChars(String(text ?? '').trim(), 160)
  if (clean.length < 6) return null
  const norm = normalizeText(clean)
  for (const row of listCaptures(db, { limit: 50 })) {
    if (similarity(norm, row.norm) >= PENDING_THRESHOLD) return null
  }
  const pending = listCaptures(db, { limit: MAX_PENDING })
  if (pending.length >= MAX_PENDING) {
    // drop the oldest proposal instead of growing without bound
    const oldest = pending[pending.length - 1]
    if (oldest) db.prepare(`UPDATE captures SET status = 'expired' WHERE id = ?`).run(oldest.id)
  }
  const id = newId(now)
  db.prepare(
    `INSERT INTO captures (id, session_id, text, norm, cue, status, memory_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?)`,
  ).run(id, String(sessionId ?? ''), clean, norm, String(cue ?? 'new'), now)
  return getCapture(db, id)
}

export function markCapture(db, id, status, memoryId = null) {
  const row = getCapture(db, id)
  if (!row) return false
  db.prepare(`UPDATE captures SET status = ?, memory_id = ? WHERE id = ?`).run(status, memoryId, id)
  return true
}

/** Mark the pending proposal closest to `text` as accepted (called after seed_remember). */
export function matchCapture(db, text, memoryId) {
  const norm = normalizeText(text ?? '')
  if (!norm) return null
  let best = null
  let bestScore = 0
  for (const row of listCaptures(db, { limit: MAX_PENDING })) {
    const score = similarity(norm, row.norm)
    if (score > bestScore) {
      bestScore = score
      best = row
    }
  }
  if (best && bestScore >= MATCH_THRESHOLD) {
    markCapture(db, best.id, 'accepted', memoryId)
    return best.id
  }
  return null
}

/** Accept from the panel: write the proposal through the normal store path. */
export function acceptCapture(db, store, id, { layer = 'semantic', now = Date.now() } = {}) {
  const row = getCapture(db, id)
  if (!row || row.status !== 'pending') return null
  const memory = store.remember({ text: row.text, layer, source: 'user-said', importance: 0.55, now })
  markCapture(db, id, 'accepted', memory?.id ?? null)
  return memory
}

export function expireCaptures(db, { days = EXPIRE_DAYS, now = Date.now() } = {}) {
  const cut = now - days * 24 * 3600 * 1000
  const info = db
    .prepare(`UPDATE captures SET status = 'expired' WHERE status = 'pending' AND created_at < ?`)
    .run(cut)
  return Number(info.changes ?? 0)
}

/** One injection line with the oldest pending proposals; empty when there are none. */
export function captureLine(db, { max = 2, budget = 160 } = {}) {
  const pending = listCaptures(db, { limit: max })
  if (!pending.length) return ''
  const fresh = []
  for (const row of pending) {
    // 已经记过的事不必再问一遍：顺手把这条候选挂到那条记忆上，不再占着「待记」
    const known = findKnown(db, row.text)
    if (known) {
      try {
        markCapture(db, row.id, 'accepted', known.id ?? null)
      } catch {}
      continue
    }
    fresh.push(row)
  }
  if (!fresh.length) return ''
  const items = fresh.map((row, i) => `${'①②③④⑤'[i] ?? i + 1}${truncateChars(row.text, 42)}`).join(' ')
  const line = `[待记] 可能值得记：${items}（值得就 seed_remember；不值得就不用管）`
  return line.length > budget ? line.slice(0, budget - 1) + '…' : line
}

export function captureStats(db) {
  const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM captures GROUP BY status`).all()
  const out = { pending: 0, accepted: 0, dismissed: 0, expired: 0 }
  for (const row of rows) out[row.status] = Number(row.n)
  return out
}
