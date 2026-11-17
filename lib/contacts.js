// 熟人卡：一个人一张，一个群一张。
// 只存短的、能直接看懂的字段——称呼、关系、生日、喜欢什么、要留神的备注。
// 它不是记忆（不进四层、不参与打分），是聊天时那张「这个人是谁」的小卡片。

const FIELDS = ['name', 'relation', 'birthday', 'likes', 'notes']
const MAX_FIELD = 120

export function cleanField(value, max = MAX_FIELD) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** 'private:100000001' / 'group:200000001' → { scope, peer, key } */
export function parsePeer(key) {
  const text = String(key ?? '').trim()
  const m = /^(private|group):(.+)$/.exec(text)
  if (!m) return null
  return { scope: m[1], peer: m[2], key: `${m[1]}:${m[2]}` }
}

export function peerLabel(key) {
  const info = parsePeer(key)
  if (!info) return 'QQ'
  return info.scope === 'group' ? 'QQ 群' : 'QQ 私聊'
}

export function setContact(db, input = {}, now = Date.now()) {
  const info = parsePeer(input.peer ?? input.key)
  if (!info) return null
  const existing = getContact(db, info.key)
  const row = { peer: info.key }
  for (const field of FIELDS) {
    const raw = input[field]
    row[field] = raw === undefined ? (existing?.[field] ?? '') : cleanField(raw)
  }
  db.prepare(
    `INSERT INTO contacts (peer, name, relation, birthday, likes, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(peer) DO UPDATE SET
       name = excluded.name,
       relation = excluded.relation,
       birthday = excluded.birthday,
       likes = excluded.likes,
       notes = excluded.notes,
       updated_at = excluded.updated_at`,
  ).run(row.peer, row.name, row.relation, row.birthday, row.likes, row.notes, now)
  return getContact(db, info.key)
}

export function getContact(db, key) {
  const info = parsePeer(key)
  if (!info) return null
  const row = db.prepare('SELECT peer, name, relation, birthday, likes, notes, updated_at FROM contacts WHERE peer = ?').get(info.key)
  return row ?? null
}

export function listContacts(db, { limit = 50 } = {}) {
  const max = Math.max(1, Math.min(200, Number(limit) || 50))
  return db
    .prepare('SELECT peer, name, relation, birthday, likes, notes, updated_at FROM contacts ORDER BY updated_at DESC LIMIT ?')
    .all(max)
}

export function forgetContact(db, key) {
  const info = parsePeer(key)
  if (!info) return false
  const res = db.prepare('DELETE FROM contacts WHERE peer = ?').run(info.key)
  return Number(res.changes) > 0
}

/** 卡片上的一行：认得就说认得，字段缺的就不提。 */
export function contactLine(contact, max = 180) {
  if (!contact) return ''
  const bits = []
  if (contact.name) bits.push(`称呼 ${contact.name}`)
  if (contact.relation) bits.push(`关系 ${contact.relation}`)
  if (contact.birthday) bits.push(`生日 ${contact.birthday}`)
  if (contact.likes) bits.push(`喜欢 ${contact.likes}`)
  if (contact.notes) bits.push(`备注 ${contact.notes}`)
  if (!bits.length) return ''
  const body = bits.join('；')
  const head = contact.name ? contact.name : '这个人'
  const line = `[熟人] ${head}（${peerLabel(contact.peer)}）：${body}`
  return line.length > max ? line.slice(0, max) + '…' : line
}

export { FIELDS as CONTACT_FIELDS }
