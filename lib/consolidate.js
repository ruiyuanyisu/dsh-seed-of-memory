import { randomUUID } from 'node:crypto'
import { promotionScore, explainScore, TIER_OF_LAYER } from './classify.js'

const DAY = 24 * 60 * 60 * 1000

/**
 * 给旧数据补 tier / expires_at（v0.11 之前所有记忆都是默认 'long'）。
 * 只动「还是默认层」的行，不覆盖用户后来手动改过的。
 */
export function backfillTiers(db) {
  const update = db.prepare(
    `UPDATE memories SET tier = ? WHERE tier = 'long' AND layer = ? AND status = 'active'`,
  )
  for (const [layer, tier] of Object.entries(TIER_OF_LAYER)) {
    if (tier !== 'long') update.run(tier, layer)
  }
  const expiry = db.prepare(
    `UPDATE memories SET expires_at = COALESCE(expires_at, recorded_at + ?) WHERE tier = 'working'`,
  ).run(7 * DAY)
  return { retiered: expiry.changes }
}

function emotionStrength(db, memoryId) {
  const row = db
    .prepare('SELECT MAX(ABS(valence) * intensity) AS s FROM emotions WHERE memory_id = ?')
    .get(memoryId)
  return Number(row?.s ?? 0)
}

/** 只看还没到 long 的 active 记忆，生成待办（不改库）。 */
export function planConsolidation(db, { now = Date.now(), limit = 500 } = {}) {
  const rows = db
    .prepare(
      `SELECT * FROM memories WHERE status = 'active' AND tier != 'long'
       ORDER BY recorded_at DESC LIMIT ?`,
    )
    .all(limit)
  const actions = []
  for (const row of rows) {
    if (row.tier === 'working' && row.expires_at && row.expires_at <= now) {
      actions.push({ row, action: 'expire', score: 0, reasons: ['工作记忆到期'] })
      continue
    }
    const emotion = emotionStrength(db, row.id)
    const result = promotionScore(row, { emotion })
    if (result.score >= result.threshold) {
      actions.push({
        row,
        action: 'promote',
        score: result.score,
        threshold: result.threshold,
        reasons: [explainScore(result), `门槛 ${result.threshold}`],
      })
    }
  }
  return actions
}

/** 执行 plan 的结果，逐条写 consolidation_log，整批一个事务。 */
export function applyConsolidation(db, actions, { now = Date.now() } = {}) {
  if (!actions.length) return { promoted: 0, expired: 0, logged: 0 }
  const log = db.prepare(
    `INSERT INTO consolidation_log (id, memory_id, action, score, reasons, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const promote = db.prepare(
    `UPDATE memories SET tier = 'long', strength = ?, expires_at = NULL WHERE id = ?`,
  )
  const expire = db.prepare(`UPDATE memories SET status = 'retired', valid_to = ? WHERE id = ?`)
  let promoted = 0
  let expired = 0
  // 用 SAVEPOINT 而不是裸 BEGIN：调用链上如果已经开着事务（宿主、别的 tick、
  // 或者将来某处把巩固包进更大的事务里），裸 BEGIN 会抛
  // "cannot start a transaction within a transaction"，整批巩固静默失败，
  // 而那句裸 ROLLBACK 还会把调用方的事务一起回滚掉。
  db.exec('SAVEPOINT seed_consolidate')
  try {
    for (const item of actions) {
      const reasons = JSON.stringify(item.reasons ?? [])
      if (item.action === 'promote') {
        promote.run(Math.min(1, 0.5 + (item.score ?? 0) / 2), item.row.id)
        promoted += 1
      } else if (item.action === 'expire') {
        expire.run(now, item.row.id)
        expired += 1
      }
      log.run(randomUUID(), item.row.id, item.action, item.score ?? 0, reasons, now)
    }
    db.exec('RELEASE seed_consolidate')
  } catch (error) {
    try {
      db.exec('ROLLBACK TO seed_consolidate')
      db.exec('RELEASE seed_consolidate')
    } catch {
      /* 回滚本身失败也不能把原始错误盖掉 */
    }
    throw error
  }
  return { promoted, expired, logged: actions.length }
}

/** 面板用：各层数量、最近一次巩固记录。 */
export function consolidationView(db) {
  const tiers = db
    .prepare(
      `SELECT tier, COUNT(*) AS n FROM memories WHERE status = 'active' GROUP BY tier`,
    )
    .all()
  const recent = db
    .prepare(
      `SELECT c.*, m.text FROM consolidation_log c
       LEFT JOIN memories m ON m.id = c.memory_id
       ORDER BY c.created_at DESC LIMIT 10`,
    )
    .all()
    .map((row) => ({ ...row, reasons: safeJson(row.reasons) }))
  return { tiers, recent }
}

function safeJson(value) {
  try {
    return JSON.parse(value ?? '[]')
  } catch {
    return []
  }
}
