/**
 * Beliefs: what the agent thinks is true about her / about the relationship.
 *
 * These are the yardstick the appraisal layer measures events against —
 * "she dislikes being rushed" makes a rushed reply matter more than a
 * random slow one. Beliefs are proposed, not proven: each carries a
 * confidence, the evidence it was built from, and can be marked contested.
 */
import { randomBytes } from 'node:crypto'
import { normalizeText } from './store.js'
import { canonScope, ownScopes, scopeFilter } from './scope.js'

function clamp(n, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}

export function newBeliefId(now = Date.now()) {
  return `b_${now.toString(36)}${randomBytes(3).toString('hex')}`
}

export function rememberBelief(db, input = {}, now = Date.now()) {
  const claim = String(input.claim ?? '').trim()
  if (!claim) throw new Error('claim is required')
  const norm = normalizeText(claim)
  const factKey = input.factKey != null ? String(input.factKey) : null
  const confidence = clamp(input.confidence ?? (input.source === 'user-said' ? 0.8 : 0.55), 0, 1)
  const sensitivity = clamp(input.sensitivity ?? 0.5, 0, 1)
  const evidence = JSON.stringify(
    Array.isArray(input.evidence) ? input.evidence.map(String).slice(0, 20) : []
  )
  const source = ['user-said', 'inferred', 'rule', 'import'].includes(input.source)
    ? input.source
    : 'inferred'
  // 谁说的就算谁的：老大说的「他不喜欢被催」和 QQ 上某人说的，是两条尺子。
  const scope = canonScope(input.scope)

  if (factKey) {
    const scopes = ownScopes(scope)
    const prev = db
      .prepare(
        `SELECT id, claim, norm, scope FROM beliefs WHERE fact_key = ? AND status = 'active'
           AND scope IN (${scopes.map(() => '?').join(', ')})
         ORDER BY (scope = ?) DESC, updated_at DESC LIMIT 1`,
      )
      .get(factKey, ...scopes, scope)
    const prevScope = String(prev?.scope ?? '')
    if (prev && prev.norm === norm) {
      db.prepare('UPDATE beliefs SET confidence = MAX(confidence, ?), evidence = ?, updated_at = ? WHERE id = ?')
        .run(confidence, evidence, now, prev.id)
      return { id: prev.id, merged: true, status: 'active' }
    }
    if (prev) {
      const id = newBeliefId(now)
      // 当面顶掉的是共用层那条：这条认知本来就还是「我们之间」的，
      // 留在 shared，别降成只有 GUI 看得见的一份（不然两边各一条，自相矛盾）。
      const nextScope = prevScope === 'shared' && scope !== 'shared' ? 'shared' : scope
      db.prepare(
        `INSERT INTO beliefs (id, claim, norm, fact_key, confidence, sensitivity, evidence, source, scope, status, superseded_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`
      ).run(id, claim, norm, factKey, confidence, sensitivity, evidence, source, nextScope, now, now)
      db.prepare("UPDATE beliefs SET status = 'retired', superseded_by = ?, updated_at = ? WHERE id = ?")
        .run(id, now, prev.id)
      return { id, superseded: prev.id, status: 'active' }
    }
  }

  // 没给键的同一条认知也不该记成两条：按规整后的原句合并（「他不喜欢被催」说三遍还是一条）。
  // 口径要和上面有键那支一致：只看「自己能接管的档」。
  // 用 visibleScopes 的话，gui 会连老桶 qq 都算进来，于是把老桶那条的置信度改掉
  // —— 而那条在卡片上根本不显示（REVIEW-152 第十五轮）。
  const mine = ownScopes(scope)
  const same = db
    .prepare(
      `SELECT id FROM beliefs WHERE norm = ? AND status = 'active'
         AND scope IN (${mine.map(() => '?').join(', ')})
       ORDER BY (scope = ?) DESC, updated_at DESC LIMIT 1`,
    )
    .get(norm, ...mine, scope)
  if (same) {
    db.prepare('UPDATE beliefs SET confidence = MAX(confidence, ?), evidence = ?, updated_at = ? WHERE id = ?')
      .run(confidence, evidence, now, same.id)
    return { id: same.id, merged: true, status: 'active' }
  }

  const id = newBeliefId(now)
  db.prepare(
    `INSERT INTO beliefs (id, claim, norm, fact_key, confidence, sensitivity, evidence, source, scope, status, superseded_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`
  ).run(id, claim, norm, factKey, confidence, sensitivity, evidence, source, scope, now, now)
  return { id, status: 'active' }
}

export function listBeliefs(db, { limit = 20, includeRetired = false, includeContested = false, scope = null } = {}) {
  const clauses = []
  if (!includeRetired) clauses.push(includeContested ? "status IN ('active','contested')" : "status = 'active'")
  if (scope) {
    const visible = scopeFilter('scope', scope)
    clauses.push(visible.sql)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return db
    .prepare(`SELECT id, claim, fact_key, confidence, sensitivity, evidence, source, scope, status, superseded_by, created_at, updated_at
              FROM beliefs ${where} ORDER BY confidence DESC, updated_at DESC LIMIT ?`)
    .all(...(scope ? scopeFilter('scope', scope).params : []), Math.max(1, Math.min(200, Number(limit) || 20)))
    .map((row) => ({ ...row, evidence: safeParse(row.evidence) }))
}

export function getBelief(db, id) {
  const row = db.prepare('SELECT * FROM beliefs WHERE id = ?').get(String(id))
  if (!row) return null
  return { ...row, evidence: safeParse(row.evidence) }
}

export function setBeliefStatus(db, id, status, now = Date.now()) {
  const allowed = new Set(['active', 'contested', 'retired'])
  if (!allowed.has(status)) throw new Error(`unknown status: ${status}`)
  db.prepare('UPDATE beliefs SET status = ?, updated_at = ? WHERE id = ?').run(status, now, String(id))
  return getBelief(db, id)
}

function safeParse(text) {
  try {
    const value = JSON.parse(text)
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}
