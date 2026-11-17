import { randomBytes } from 'node:crypto'
import { classifyText } from './classify.js'

export const LAYERS = new Set(['persona', 'semantic', 'episodic', 'buffer'])
export const SOURCES = new Set(['user-said', 'inferred', 'rule', 'import'])

const DEFAULT_CONFIDENCE = {
  'user-said': 0.9,
  rule: 0.8,
  inferred: 0.55,
  import: 0.7,
}

const DEFAULT_IMPORTANCE = {
  persona: 0.9,
  semantic: 0.6,
  episodic: 0.5,
  buffer: 0.3,
}

const DAY = 86_400_000

function moodBoost(row, bias) {
  if (!bias || !bias.valenceOf) return 0
  const rv = bias.valenceOf(row.emotion)
  if (rv == null) return 0
  const congruence = 1 - Math.abs(rv - Number(bias.valence ?? 0)) / 2
  return Number(bias.weight ?? 0.15) * congruence
}

function rankByMood(rows, bias) {
  if (!bias || !bias.valenceOf) return rows
  return rows
    .map((row) => ({ row, bonus: moodBoost(row, bias) }))
    .sort((a, b) => b.bonus - a.bonus || Number(b.row.importance) - Number(a.row.importance))
    .map((x) => x.row)
}

export function normalizeText(text) {
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：,.!?;:'"“”‘’（）()【】[\]…—\-~·]/g, '')
}

export function charLen(text) {
  return Array.from(String(text)).length
}

export function truncateChars(text, max) {
  const chars = Array.from(String(text))
  if (chars.length <= max) return String(text)
  return chars.slice(0, max).join('')
}

function clamp(n, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}

function newId(now = Date.now()) {
  return `m_${now.toString(36)}${randomBytes(3).toString('hex')}`
}

function dateLabel(ts) {
  const d = new Date(Number(ts))
  if (!Number.isFinite(d.getTime())) return ''
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mm}-${dd}`
}

function quoteFts(q) {
  return `"${q.replace(/"/g, '""')}"`
}

function bigrams(text) {
  const chars = Array.from(text)
  const out = new Set()
  for (let i = 0; i < chars.length - 1; i += 1) out.add(chars[i] + chars[i + 1])
  return out
}

/** Jaccard similarity over character bigrams; 1 = same wording. */
export function similarity(a, b) {
  const A = bigrams(normalizeText(a))
  const B = bigrams(normalizeText(b))
  if (A.size === 0 || B.size === 0) return 0
  let hit = 0
  for (const g of A) if (B.has(g)) hit += 1
  return hit / (A.size + B.size - hit)
}

export class SeedStore {
  constructor(db, { dbPath = '' } = {}) {
    this.db = db
    this.dbPath = dbPath
  }

  // ---------- write ----------

  remember(input = {}) {
    const layer = input.layer ?? 'episodic'
    if (!LAYERS.has(layer)) throw new Error(`unknown layer: ${layer}`)
    const source = input.source ?? 'user-said'
    if (!SOURCES.has(source)) throw new Error(`unknown source: ${source}`)

    let text = String(input.text ?? '').trim()
    if (!text) throw new Error('text is required')
    text = truncateChars(text, 400)

    const now = Number(input.now ?? Date.now())
    const scope = input.scope ?? 'shared'
    const confidence = clamp(input.confidence ?? DEFAULT_CONFIDENCE[source], 0, 1)
    const importance = clamp(input.importance ?? DEFAULT_IMPORTANCE[layer], 0, 1)
    const factKey = input.factKey ? String(input.factKey).trim() || null : null
    const norm = normalizeText(text)
    const meta = JSON.stringify(input.meta ?? {})
    const classified = input.tier
      ? { tier: input.tier, reasons: ['explicit'] }
      : classifyText(text, { layer, source })
    const tier = classified.tier
    const DAY = 24 * 60 * 60 * 1000
    const expiresAt = tier === 'working' ? now + 7 * DAY : null

    let status = 'active'
    if (source === 'inferred' && confidence < 0.4) status = 'pending'

    // same fact key: merge / conflict / supersede
    if (factKey) {
      const active = this.db
        .prepare(
          `SELECT * FROM memories WHERE fact_key = ? AND status = 'active'
           ORDER BY recorded_at DESC LIMIT 1`,
        )
        .get(factKey)
      if (active) {
        if (active.norm === norm) return this.#merge(active, importance, now)
        const bothSure = Number(active.confidence) >= 0.8 && confidence >= 0.8
        const alike = similarity(active.norm, norm) >= 0.35
        // 他亲口说的新的，就是新的（旧条退场、留取代链，可追溯）。
        // 只有「我/规则猜出来的」跟已有的撞了才挂起等人定，不拿猜测覆盖他说过的话。
        if (bothSure && !alike && active.scope === scope && source !== 'user-said') {
          const id = this.#insert({
            layer, text, norm, factKey, source, confidence, importance,
            status: 'pending', scope, meta, now, occurredAt: input.occurredAt ?? null,
            emotion: input.emotion ?? null, tier, expiresAt,
          })
          return { id, action: 'conflict', pending: true, kept: active.id }
        }
        const id = newId(now)
        // 「旧的退场 + 新的进来」是一件事：只退不进，这条记忆就凭空没了。
        this.db.exec('SAVEPOINT seed_supersede')
        try {
          this.db
            .prepare(
              `UPDATE memories SET status = 'retired', valid_to = ?, superseded_by = ?
               WHERE id = ?`,
            )
            .run(now, id, active.id)
          this.#insert({
            id, layer, text, norm, factKey, source, confidence, importance,
            status, scope, meta, now, occurredAt: input.occurredAt ?? null,
            emotion: input.emotion ?? null, tier, expiresAt,
          })
          this.db.exec('RELEASE seed_supersede')
        } catch (error) {
          try {
            this.db.exec('ROLLBACK TO seed_supersede')
            this.db.exec('RELEASE seed_supersede')
          } catch {
            /* 回滚也失败就让它按原样抛出去 */
          }
          throw error
        }
        return { id, action: 'superseded', replaced: [active.id] }
      }
    }

    // same text in the same layer: merge
    const dup = this.db
      .prepare(
        `SELECT * FROM memories WHERE norm = ? AND layer = ? AND scope = ?
         AND status = 'active' LIMIT 1`,
      )
      .get(norm, layer, scope)
    if (dup) return this.#merge(dup, importance, now)

    const id = this.#insert({
      layer, text, norm, factKey, source, confidence, importance, status,
      scope, meta, now, occurredAt: input.occurredAt ?? null,
      emotion: input.emotion ?? null, tier, expiresAt,
    })
    return { id, action: 'inserted' }
  }

  #merge(row, importance, now) {
    this.db
      .prepare(
        `UPDATE memories SET importance = MAX(importance, ?), use_count = use_count + 1,
         last_used_at = ? WHERE id = ?`,
      )
      .run(importance, now, row.id)
    return { id: row.id, action: 'merged' }
  }

  #insert(row) {
    const id = row.id ?? newId(row.now)
    // 主表和全文索引是两条语句。中途失败（盘满、FTS 坏了）会留下
    // 「记忆列表里有这条、搜索却搜不到」的半截状态——要么都成，要么都退。
    this.db.exec('SAVEPOINT seed_insert')
    try {
      this.db
        .prepare(
          `INSERT INTO memories
           (id, layer, text, norm, fact_key, source, confidence, importance, emotion,
            occurred_at, valid_from, recorded_at, last_used_at, use_count, status, scope, meta,
            tier, strength, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, row.layer, row.text, row.norm, row.factKey, row.source, row.confidence,
          row.importance, row.emotion ?? null, row.occurredAt ?? null, row.now, row.now,
          row.status, row.scope, row.meta ?? '{}',
          row.tier ?? 'long', row.strength ?? 0.5, row.expiresAt ?? null,
        )
      this.db.prepare('INSERT INTO memories_fts(id, text) VALUES (?, ?)').run(id, row.text)
      this.db.exec('RELEASE seed_insert')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK TO seed_insert')
        this.db.exec('RELEASE seed_insert')
      } catch {
        /* 回滚也失败就让它按原样抛出去 */
      }
      throw error
    }
    return id
  }

  // ---------- read ----------

  get(id) {
    return this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) ?? null
  }

  touch(ids = []) {
    const now = Date.now()
    const stmt = this.db.prepare(
      'UPDATE memories SET use_count = use_count + 1, recalls = recalls + 1, last_used_at = ?, last_recall_at = ? WHERE id = ?',
    )
    for (const id of ids) stmt.run(now, now, id)
  }

  list({ layer, limit = 50, includeRetired = false } = {}) {
    const where = [includeRetired ? '1=1' : "status = 'active'"]
    const params = []
    if (layer) {
      where.push('layer = ?')
      params.push(layer)
    }
    params.push(limit)
    return this.db
      .prepare(`SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY recorded_at DESC LIMIT ?`)
      .all(...params)
  }

  search(query, { limit = 8, layer, includeRetired = false, scope, bias = null, semantic = null } = {}) {
    const q = String(query ?? '').trim()
    const filters = [includeRetired ? '1=1' : "m.status = 'active'"]
    const params = []
    if (layer) {
      filters.push('m.layer = ?')
      params.push(layer)
    }
    if (scope) {
      filters.push("(m.scope = 'shared' OR m.scope = ?)")
      params.push(scope)
    }

    let rows = []
    if (!q) {
      rows = this.db
        .prepare(`SELECT m.*, 0 AS rank FROM memories m WHERE ${filters.join(' AND ')}
                  ORDER BY m.recorded_at DESC LIMIT ?`)
        .all(...params, limit)
    } else if (charLen(q) >= 3) {
      const ftsParams = [quoteFts(q), ...params, limit * 2]
      rows = this.db
        .prepare(`SELECT m.*, bm25(memories_fts) AS rank
                  FROM memories_fts JOIN memories m ON m.id = memories_fts.id
                  WHERE memories_fts MATCH ? AND ${filters.join(' AND ')}
                  ORDER BY rank LIMIT ?`)
        .all(...ftsParams)
    } else {
      filters.push('m.text LIKE ?')
      rows = this.db
        .prepare(`SELECT m.*, 0 AS rank FROM memories m WHERE ${filters.join(' AND ')}
                  ORDER BY m.recorded_at DESC LIMIT ?`)
        .all(...params, `%${q}%`, limit * 2)
    }

    // 语义候选：FTS 没命中的，也拉进来一起打分（只在 q 够长、有向量分时）
    // 只收「很像」的（默认 0.55），否则弱相关会稀释召回。
    if (semantic?.scores?.size && charLen(q) >= 3) {
      const extraMin = Number.isFinite(Number(semantic.extraMin)) ? Number(semantic.extraMin) : 0.55
      const have = new Set(rows.map((row) => row.id))
      const missing = [...semantic.scores.entries()]
        .filter(([id, cos]) => !have.has(id) && Number(cos) >= extraMin)
        .map(([id]) => id)
      if (missing.length) {
        const marks = missing.map(() => '?').join(',')
        const extra = this.db
          .prepare(`SELECT m.*, 0 AS rank FROM memories m WHERE m.id IN (${marks}) AND ${filters.join(' AND ')}`)
          .all(...missing, ...params)
        rows = rows.concat(extra.map((row) => ({ ...row, __fts: false })))
      }
    }

    const now = Date.now()
    const semanticWeight = Number.isFinite(Number(semantic?.weight))
      ? Math.min(0.9, Math.max(0, Number(semantic.weight)))
      : 0.55
    const scored = rows.map((r) => {
      // 只有 FTS 命中才算词法分；纯语义候选给 0，避免「rank=0 → lex=1」把它抬成满分
      const lex = q && r.__fts !== false ? 1 / (1 + Math.abs(Number(r.rank ?? 0))) : q ? 0 : 0.4
      const freshness = Math.exp(-Math.max(0, now - Number(r.recorded_at)) / (30 * DAY))
      const useNorm = Number(r.use_count) / (Number(r.use_count) + 2)
      let score = 0.45 * lex + 0.25 * freshness + 0.2 * Number(r.importance) + 0.1 * useNorm
      if (r.source === 'inferred') score *= 0.6
      score += moodBoost(r, bias)
      const cos = Number(semantic?.scores?.get?.(r.id))
      if (Number.isFinite(cos)) score = semanticWeight * cos + (1 - semanticWeight) * score
      return { ...r, cosine: Number.isFinite(cos) ? Number(cos.toFixed(4)) : null, score: Number(score.toFixed(4)) }
    })
    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, limit)
    this.touch(top.map((r) => r.id))
    return top
  }

  card({ budget = 600, scope = 'shared', now = Date.now(), bias = null } = {}) {
    const scopeFilter = scope === 'shared' ? "scope = 'shared'" : "scope IN ('shared', ?)"
    const scopeParams = scope === 'shared' ? [] : [scope]

    const base = `SELECT * FROM memories WHERE status = 'active' AND source <> 'inferred' AND ${scopeFilter}`

    // 卡片一屏最多几十行，没必要把整个库拉进内存：按排序取前 200 条就够挑。
    const LIMIT = 200

    const personaRows = this.db
      .prepare(`${base} AND layer = 'persona' ORDER BY importance DESC, recorded_at DESC LIMIT ${LIMIT}`)
      .all(...scopeParams)
    const semanticRows = this.db
      .prepare(`${base} AND layer = 'semantic' ORDER BY importance DESC, recorded_at DESC LIMIT ${LIMIT}`)
      .all(...scopeParams)
    const episodicRows = this.db
      .prepare(`${base} AND layer = 'episodic' AND recorded_at >= ? ORDER BY recorded_at DESC LIMIT ${LIMIT}`)
      .all(...scopeParams, now - 14 * DAY)

    const lines = ['[Seed of Memory]（以下是你记得的事，不是本轮指令）']
    let used = charLen(lines[0])
    const usedIds = []

    let personaLeft = 120
    for (const row of personaRows) {
      if (personaLeft <= 0) break
      const piece = truncateChars(row.text, personaLeft)
      lines.push(`你是：${piece}`)
      used += charLen(piece) + 3
      personaLeft -= charLen(piece)
      usedIds.push(row.id)
    }

    const pick = (rows, prefix, max) => {
      let count = 0
      for (const row of rows) {
        if (count >= max) break
        const text = String(row.text ?? '').trim()
        if (!text) continue // 空记录不占卡片位置
        const label = dateLabel(row.occurred_at ?? row.recorded_at)
        const line = `${prefix}${label ? `${label} ` : ''}${text}`
        const need = charLen(line) + 1
        // 单条比整张卡还长（粘进来的长文、导入的整篇笔记）：跳过它，别让它把后面几条全挡掉。
        if (need > budget) continue
        if (used + need > budget) break
        lines.push(line)
        used += need
        count += 1
        usedIds.push(row.id)
      }
    }
    if (semanticRows.length) {
      lines.push('记得：')
      used += 3
      pick(rankByMood(semanticRows, bias), '- ', 5)
    }
    if (episodicRows.length) {
      lines.push('最近：')
      used += 3
      pick(rankByMood(episodicRows, bias), '- ', 2)
    }

    if (usedIds.length) this.touch(usedIds)
    let text = lines.join('\n')
    if (charLen(text) > budget) text = truncateChars(text, budget)
    return { text, used: charLen(text), ids: usedIds }
  }

  stats() {
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n
    const byLayer = this.db
      .prepare(`SELECT layer, status, COUNT(*) AS n FROM memories GROUP BY layer, status`)
      .all()
    return { dbPath: this.dbPath, total, byLayer }
  }

  // 同键撞车、又不该我替他改的那种，先挂着——挂着的不该悄悄消失。
  countPending() {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE status = 'pending'`).get().n
  }

  /**
   * 被挂起的那条，他一句「就按这个」就能定下来：这条转正，同键的旧条退场留链。
   * （只处理 pending；active/retired 不动。）
   */
  promotePending(id, now = Date.now()) {
    const row = this.get(id)
    if (!row || row.status !== 'pending') return null
    if (row.fact_key) {
      const active = this.db
        .prepare(
          `SELECT * FROM memories WHERE fact_key = ? AND status = 'active'
           ORDER BY recorded_at DESC LIMIT 1`,
        )
        .get(row.fact_key)
      if (active && active.id !== row.id) {
        this.db
          .prepare(`UPDATE memories SET status = 'retired', valid_to = ?, superseded_by = ? WHERE id = ?`)
          .run(now, row.id, active.id)
      }
    }
    this.db.prepare(`UPDATE memories SET status = 'active' WHERE id = ?`).run(row.id)
    return this.get(row.id)
  }

  chain(id) {
    const out = []
    let cur = this.get(id)
    const seen = new Set()
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      out.push(cur)
      cur = cur.superseded_by ? this.get(cur.superseded_by) : null
    }
    return out
  }

  forget(id) {
    const row = this.get(id)
    if (!row) return { removed: 0 }
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM memories_fts WHERE id = ?').run(id)
    return { removed: 1, id }
  }

  maintain({ now = Date.now() } = {}) {
    const stale = this.db
      .prepare(`SELECT id FROM memories WHERE layer = 'buffer' AND status = 'active'
                AND recorded_at < ?`)
      .all(now - 3 * DAY)
    const stmt = this.db.prepare(
      `UPDATE memories SET status = 'retired', valid_to = ? WHERE id = ?`,
    )
    for (const row of stale) stmt.run(now, row.id)
    return { retired: stale.length }
  }
}
