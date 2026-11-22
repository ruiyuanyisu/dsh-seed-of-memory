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

/** 九十天没被再印证，就往地板掉一半。 */
export const BELIEF_HALF_LIFE_DAYS = 90
/** 再怎么淡，也不直接归零：淡到底只是「不太当真」。 */
export const BELIEF_CONFIDENCE_FLOOR = 0.2

/**
 * 认知会淡：从「最后一次被印证」起算，半衰期九十天。
 * 读的时候算、不写库——掉分看得见，也随时能重算，不会把库改坏。
 */
export function effectiveConfidence(row, now = Date.now()) {
  const base = clamp(row?.confidence ?? 0, 0, 1)
  const anchor = Number(row?.confirmed_at ?? row?.updated_at ?? row?.created_at ?? now) || Number(now)
  const days = Math.max(0, (Number(now) - anchor) / 86_400_000)
  const factor = Math.pow(0.5, days / BELIEF_HALF_LIFE_DAYS)
  return clamp(BELIEF_CONFIDENCE_FLOOR + (base - BELIEF_CONFIDENCE_FLOOR) * factor, 0, 1)
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
      // 重复一次不等于更确信：涨有顶（0.95），并且记下「最后一次被印证」的时间。
      db.prepare(
        'UPDATE beliefs SET confidence = MIN(0.95, MAX(confidence, ?)), confirmed_at = ?, evidence = ?, updated_at = ? WHERE id = ?',
      ).run(confidence, now, evidence, now, prev.id)
      return { id: prev.id, merged: true, status: 'active' }
    }
    if (prev) {
      const id = newBeliefId(now)
      // 当面顶掉的是共用层那条：这条认知本来就还是「我们之间」的，
      // 留在 shared，别降成只有 GUI 看得见的一份（不然两边各一条，自相矛盾）。
      const nextScope = prevScope === 'shared' && scope !== 'shared' ? 'shared' : scope
      db.prepare(
        `INSERT INTO beliefs (id, claim, norm, fact_key, confidence, sensitivity, evidence, source, scope, status, superseded_by, created_at, updated_at, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?)`
      ).run(id, claim, norm, factKey, confidence, sensitivity, evidence, source, nextScope, now, now, now)
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
    db.prepare(
      'UPDATE beliefs SET confidence = MIN(0.95, MAX(confidence, ?)), confirmed_at = ?, evidence = ?, updated_at = ? WHERE id = ?',
    ).run(confidence, now, evidence, now, same.id)
    return { id: same.id, merged: true, status: 'active' }
  }

  const id = newBeliefId(now)
  db.prepare(
    `INSERT INTO beliefs (id, claim, norm, fact_key, confidence, sensitivity, evidence, source, scope, status, superseded_by, created_at, updated_at, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?)`
  ).run(id, claim, norm, factKey, confidence, sensitivity, evidence, source, scope, now, now, now)
  return { id, status: 'active' }
}

export function listBeliefs(
  db,
  { limit = 20, includeRetired = false, includeContested = false, includePending = false, scope = null, now = Date.now() } = {},
) {
  // 状态是白名单而不是「除了退休都算」：加了 pending 以后，老写法会把候选也漏出去。
  const wanted = ['active']
  if (includeContested) wanted.push('contested')
  if (includePending) wanted.push('pending')
  if (includeRetired) wanted.push('retired')
  const clauses = [`status IN (${wanted.map(() => '?').join(', ')})`]
  const params = [...wanted]
  if (scope) {
    const visible = scopeFilter('scope', scope)
    clauses.push(visible.sql)
    params.push(...visible.params)
  }
  const where = `WHERE ${clauses.join(' AND ')}`
  return db
    .prepare(`SELECT id, claim, fact_key, confidence, sensitivity, evidence, source, scope, status, superseded_by, created_at, updated_at, confirmed_at
              FROM beliefs ${where} LIMIT ?`)
    .all(...params, Math.max(1, Math.min(200, Number(limit) || 20)))
    .map((row) => ({ ...row, evidence: safeParse(row.evidence), effective: effectiveConfidence(row, now) }))
    .sort((a, b) => b.effective - a.effective || Number(b.updated_at) - Number(a.updated_at))
}

export function getBelief(db, id) {
  const row = db.prepare('SELECT * FROM beliefs WHERE id = ?').get(String(id))
  if (!row) return null
  return { ...row, evidence: safeParse(row.evidence) }
}

export function setBeliefStatus(db, id, status, now = Date.now()) {
  const allowed = new Set(['active', 'contested', 'pending', 'retired'])
  if (!allowed.has(status)) throw new Error(`unknown status: ${status}`)
  // 重新承认一条认知，等于重新印证一次：新鲜度从今天重算。
  db.prepare('UPDATE beliefs SET status = ?, updated_at = ?, confirmed_at = COALESCE(?, confirmed_at) WHERE id = ?')
    .run(status, now, status === 'active' ? now : null, String(id))
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
