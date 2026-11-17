// 未完话头：我问过、还没落定的那一句。
// 两天之内他回话，就交给模型判断是完成、取消还是更新；不回就慢慢到期。
// 它不是定时提醒，是一句「上次说到哪了」的钩子。

export const LOOSE_HOURS = 48
const MAX_ASK = 120

/** 从我们发出去的话里挑一句要等回音的。挑不出就返回 ''。 */
export function extractQuestion(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return ''
  const sentences = raw
    .split(/(?<=[。！？!?…～~；;\n])/)
    .map((part) => part.trim())
    .filter(Boolean)
  const asked = [...sentences].reverse().find((line) => /[？?]\s*$/.test(line))
  if (asked) return asked.slice(0, MAX_ASK)
  // 没有问号、但用了「…吗 / …嘛 / …呢」收尾，也算在等回话
  const tail = sentences[sentences.length - 1] ?? ''
  if (/[吗嘛呢]\s*[。！!～~…]*$/.test(tail)) return tail.slice(0, MAX_ASK)
  return ''
}

function looseId(now) {
  const stamp = Number(now || Date.now()).toString(36)
  const salt = Math.random().toString(36).slice(2, 6)
  return `l_${stamp}${salt}`
}

export function addLoose(db, { peer, ask, sessionId = '', hours = LOOSE_HOURS, now = Date.now() } = {}) {
  const text = String(peer ?? '').trim()
  const question = String(ask ?? '').trim().slice(0, MAX_ASK)
  if (!text || !question) return null
  // 同一句没落定过就别重复记
  const same = db
    .prepare("SELECT id FROM loose_ends WHERE peer = ? AND ask = ? AND status = 'open' ORDER BY asked_at DESC LIMIT 1")
    .get(text, question)
  if (same) {
    db.prepare('UPDATE loose_ends SET asked_at = ?, due_at = ? WHERE id = ?').run(now, now + hours * 3_600_000, same.id)
    return getLoose(db, same.id)
  }
  const id = looseId(now)
  db.prepare(
    'INSERT INTO loose_ends (id, peer, session_id, ask, asked_at, due_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, text, String(sessionId ?? ''), question, now, now + hours * 3_600_000, 'open')
  return getLoose(db, id)
}

export function getLoose(db, id) {
  return db.prepare('SELECT * FROM loose_ends WHERE id = ?').get(String(id ?? '')) ?? null
}

export function openLoose(db, { peer, limit = 3 } = {}) {
  const max = Math.max(1, Math.min(20, Number(limit) || 3))
  if (peer) {
    return db
      .prepare("SELECT * FROM loose_ends WHERE peer = ? AND status = 'open' ORDER BY asked_at DESC LIMIT ?")
      .all(String(peer), max)
  }
  return db.prepare("SELECT * FROM loose_ends WHERE status = 'open' ORDER BY asked_at DESC LIMIT ?").all(max)
}

/** 他回话了：把还没落定的都标成「已回话」，等模型判断怎么收。 */
export function markReplied(db, peer, now = Date.now()) {
  const rows = db
    .prepare("SELECT id FROM loose_ends WHERE peer = ? AND status = 'open'")
    .all(String(peer ?? ''))
  for (const row of rows) {
    db.prepare("UPDATE loose_ends SET status = 'answered', note = COALESCE(note, '') WHERE id = ?").run(row.id)
  }
  return rows.length
}

export function closeLoose(db, { id, status = 'done', note = '', now = Date.now() } = {}) {
  const want = status === 'cancelled' || status === 'cancel' ? 'cancelled' : status === 'update' ? 'updated' : 'done'
  const row = getLoose(db, id)
  if (!row) return null
  db.prepare('UPDATE loose_ends SET status = ?, closed_at = ?, note = ? WHERE id = ?').run(want, now, String(note ?? ''), row.id)
  return getLoose(db, row.id)
}

export function listLoose(db, { peer = '', status = null, limit = 10 } = {}) {
  const max = Math.max(1, Math.min(50, Number(limit) || 10))
  const clauses = []
  const params = []
  // 默认只列「还挂着的」：open（没等到回音）+ answered（回了但还没收）。要全部就传 status: ''。
  if (status === null) clauses.push("status IN ('open', 'answered')")
  if (peer) {
    clauses.push('peer = ?')
    params.push(String(peer))
  }
  if (status) {
    clauses.push('status = ?')
    params.push(String(status))
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return db.prepare(`SELECT * FROM loose_ends ${where} ORDER BY asked_at DESC LIMIT ?`).all(...params, max)
}

function ago(hours) {
  if (hours < 1) return '刚才'
  if (hours < 24) return `${Math.round(hours)} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

/** 卡片上的几行：还没回话的、回话了但还没收的。 */
export function looseLines(db, peer, { now = Date.now(), limit = 3 } = {}) {
  const rows = listLoose(db, { peer, limit: limit + 2 })
  if (!rows.length) return []
  const out = []
  for (const row of rows) {
    if (out.length >= limit) break
    const hours = Math.max(0, (now - Number(row.asked_at ?? now)) / 3_600_000)
    if (row.status === 'open') {
      out.push(`[未完] 你${ago(hours)}问过「${row.ask}」，他还没接上——别反复追问，真要提就自然地带一句。`)
    } else if (row.status === 'answered') {
      out.push(
        `[未完] 你问过「${row.ask}」，他这次回了——看看是完成、取消还是更新，用 seed_loose done/cancel/update 收掉。`,
      )
    }
  }
  return out
}
