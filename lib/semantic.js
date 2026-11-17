// Seed of Memory — 语义索引
// 职责：把「记忆 / 认知 / 说话习惯 / 特质」的文本算成向量、存进 embeddings 表；检索时给出余弦分。
// 设计原则：运行时不可用/索引没建好时一律返回 null，让上层自动退回纯 FTS。
import { createHash } from 'node:crypto'

export const DEFAULT_SPACE = 'bge-small-zh-v1.5@512-v1'
// bge-small 实测：相关对 0.49–0.67，无关 0.24–0.39。0.30 是「重排」地板；补进新候选要更高（见 store 的 extraMin）。
export const MIN_SCORE = 0.3
export const EXTRA_MIN_SCORE = 0.55
const MAX_CANDIDATES = 5000

/**
 * 每种 ref_type 的来源：表名、文本列、状态条件、排序键。
 * 顺序也是回填的轮转顺序：记忆优先，其次认知、习惯、特质。
 */
export const REF_TYPES = [
  {
    type: 'memory',
    label: '记忆',
    sql: "SELECT id, text AS body FROM memories WHERE status = 'active' ORDER BY recorded_at DESC LIMIT ?",
    ids: "SELECT id FROM memories WHERE status = 'active'",
    total: "SELECT COUNT(*) AS n FROM memories WHERE status = 'active'",
  },
  {
    type: 'belief',
    label: '认知',
    sql: "SELECT id, claim AS body FROM beliefs WHERE status IN ('active','contested') ORDER BY updated_at DESC LIMIT ?",
    ids: "SELECT id FROM beliefs WHERE status IN ('active','contested')",
    total: "SELECT COUNT(*) AS n FROM beliefs WHERE status IN ('active','contested')",
  },
  {
    type: 'habit',
    label: '说话习惯',
    sql: "SELECT id, statement AS body FROM habits WHERE status != 'retired' ORDER BY strength DESC LIMIT ?",
    ids: "SELECT id FROM habits WHERE status != 'retired'",
    total: "SELECT COUNT(*) AS n FROM habits WHERE status != 'retired'",
  },
  {
    type: 'trait',
    label: '特质',
    sql: "SELECT id, COALESCE(statement, name) AS body FROM traits WHERE status != 'retired' ORDER BY strength DESC LIMIT ?",
    ids: "SELECT id FROM traits WHERE status != 'retired'",
    total: "SELECT COUNT(*) AS n FROM traits WHERE status != 'retired'",
  },
]

const TYPE_BY_NAME = new Map(REF_TYPES.map((item) => [item.type, item]))

export function textHash(text) {
  return createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16)
}

export function vecToBlob(vector) {
  const f32 = vector instanceof Float32Array ? vector : new Float32Array(vector)
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)
}

export function blobToVec(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
  const out = new Float32Array(Math.floor(buf.byteLength / 4))
  for (let i = 0; i < out.length; i += 1) out[i] = buf.readFloatLE(i * 4)
  return out
}

export function cosine(a, b) {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na <= 1e-12 || nb <= 1e-12) return 0
  return dot / Math.sqrt(na * nb)
}

function normalizeSpace(space) {
  return String(space ?? '').trim() || DEFAULT_SPACE
}

export class SemanticIndex {
  constructor(db, embedder, { space = DEFAULT_SPACE, dimension = 512, model = '', logger = console, batch = 16, minScore = MIN_SCORE } = {}) {
    this.db = db
    this.embedder = embedder
    this.space = normalizeSpace(space)
    this.dimension = Number(dimension) || 512
    this.model = String(model ?? '')
    this.logger = logger
    this.batch = Math.max(1, Math.min(128, Number(batch) || 16))
    this.minScore = Number.isFinite(Number(minScore)) ? Number(minScore) : MIN_SCORE
    this.lastError = ''
    this.busy = false
  }

  count(sql, ...params) {
    try {
      return Number(this.db.prepare(sql).get(...params)?.n ?? 0)
    } catch {
      return 0
    }
  }

  /** 每种 ref_type 的 总数/已索引/待补。 */
  typeStats() {
    const out = []
    for (const item of REF_TYPES) {
      const total = this.count(item.total)
      const indexed = this.count(
        `SELECT COUNT(*) AS n FROM embeddings e
         WHERE e.ref_type = ? AND e.model_space = ?
           AND e.ref_id IN (${item.ids})`,
        item.type,
        this.space,
      )
      out.push({ type: item.type, label: item.label, total, indexed, pending: Math.max(0, total - indexed) })
    }
    return out
  }

  stats() {
    const perType = this.typeStats()
    const total = perType.reduce((sum, row) => sum + row.total, 0)
    const indexed = perType.reduce((sum, row) => sum + row.indexed, 0)
    const pending = Math.max(0, total - indexed)
    return {
      space: this.space,
      dimension: this.dimension,
      total,
      indexed,
      pending,
      coverage: total === 0 ? 1 : Number((indexed / total).toFixed(3)),
      byType: perType,
      minScore: this.minScore,
      lastError: this.lastError || null,
    }
  }

  upsert(refType, refId, vector, text, now = Date.now()) {
    const vec = vector instanceof Float32Array ? vector : new Float32Array(vector)
    this.db
      .prepare(
        `INSERT INTO embeddings (ref_type, ref_id, model_space, dim, vec, text_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ref_type, ref_id, model_space) DO UPDATE SET
           dim = excluded.dim, vec = excluded.vec, text_hash = excluded.text_hash, created_at = excluded.created_at`,
      )
      .run(String(refType || 'memory'), String(refId), this.space, vec.length, vecToBlob(vec), textHash(text), now)
  }

  remove(refType, refId) {
    if (refId === undefined) {
      // 兼容旧的单参调用：remove(memoryId)
      this.db.prepare("DELETE FROM embeddings WHERE ref_type = 'memory' AND ref_id = ?").run(String(refType))
      return
    }
    this.db.prepare('DELETE FROM embeddings WHERE ref_type = ? AND ref_id = ?').run(String(refType), String(refId))
  }

  clear() {
    const result = this.db.prepare('DELETE FROM embeddings WHERE model_space = ?').run(this.space)
    return { removed: Number(result.changes ?? 0) }
  }

  pending({ limit = this.batch, type = null } = {}) {
    const size = Math.max(1, Number(limit) || this.batch)
    const types = type ? [TYPE_BY_NAME.get(type)].filter(Boolean) : REF_TYPES
    const rows = []
    for (const item of types) {
      // 关键：先把来源 SQL 末尾的 `LIMIT ?` 摘掉，让「排除已索引」在 LIMIT 之前发生。
      // 不摘的话，子查询会先按顺序截一批出来（比如最新的 8 条），这批一旦索引完，
      // 下次子查询截到的还是同样那 8 条，全被 NOT EXISTS 滤掉 → 永远返回 0 条，
      // 剩下的记忆从此再也补不进索引。
      const source = item.sql.replace(/\s+LIMIT\s+\?\s*$/i, '')
      const candidates = this.db
        .prepare(
          `SELECT t.id, t.body AS body FROM (${source}) AS t
           WHERE NOT EXISTS (
             SELECT 1 FROM embeddings e
             WHERE e.ref_type = ? AND e.ref_id = t.id AND e.model_space = ?
           )
           LIMIT ?`,
        )
        .all(item.type, this.space, size)
      for (const row of candidates) rows.push({ type: item.type, id: row.id, text: row.body })
      if (rows.length >= size) break
    }
    return rows.slice(0, size)
  }

  async embedTexts(texts) {
    if (!this.embedder) return null
    const result = await this.embedder.embed(texts, this.model || undefined)
    if (!result?.ok) {
      this.lastError = String(result?.error ?? 'embed 失败')
      return null
    }
    return result.vectors
  }

  /** 补一批（轮转覆盖记忆/认知/习惯/特质）：返回 { embedded, remaining, error }。失败只记录，不抛。 */
  async backfill({ batch } = {}) {
    if (this.busy) return { embedded: 0, remaining: this.stats().pending, skipped: true }
    this.busy = true
    try {
      const size = Math.max(1, Math.min(128, Number(batch) || this.batch))
      const rows = this.pending({ limit: size })
      // 没有待办时才说 remaining: 0；有候选但一条都没拿到的情形单独说清楚，
      // 别把「取不出来」谎报成「全补完了」。
      if (!rows.length) return { embedded: 0, remaining: this.stats().pending }
      const vectors = await this.embedTexts(rows.map((row) => row.text))
      if (!vectors) return { embedded: 0, remaining: this.stats().pending, error: this.lastError }
      let embedded = 0
      for (let i = 0; i < rows.length; i += 1) {
        const vector = vectors[i]
        if (!vector || !vector.length) continue
        this.upsert(rows[i].type, rows[i].id, vector, rows[i].text)
        embedded += 1
      }
      this.lastError = ''
      return { embedded, remaining: this.stats().pending }
    } finally {
      this.busy = false
    }
  }

  /** 单条立即索引（写入后调用；失败静默）。 */
  async indexOne(refType, refId, text) {
    if (!this.embedder) return false
    const body = String(text ?? '').trim()
    if (!body) return false
    try {
      const vectors = await this.embedTexts([body])
      if (!vectors?.length) return false
      this.upsert(refType, refId, new Float32Array(vectors[0]), body)
      this.lastError = ''
      return true
    } catch (error) {
      this.lastError = String(error?.message ?? error)
      return false
    }
  }

  /** 检索用的余弦分表；没有运行时/没有索引时返回 null。默认只查记忆，可指定 refType。 */
  async queryScores(text, { limit = 50, refType = 'memory' } = {}) {
    const q = String(text ?? '').trim()
    if (!q) return null
    const vectors = await this.embedTexts([q])
    if (!vectors?.length) return null
    const query = new Float32Array(vectors[0])
    const rows = this.db
      .prepare('SELECT ref_id, vec FROM embeddings WHERE ref_type = ? AND model_space = ? LIMIT ?')
      .all(refType, this.space, MAX_CANDIDATES)
    if (!rows.length) return null
    const hits = []
    for (const row of rows) {
      const vector = blobToVec(row.vec)
      if (vector.length !== query.length) continue
      const score = cosine(query, vector)
      if (score >= this.minScore) hits.push([row.ref_id, score])
    }
    if (!hits.length) return null
    hits.sort((a, b) => b[1] - a[1])
    return new Map(hits.slice(0, Math.max(1, Number(limit) || 50)))
  }

  /**
   * 重建索引：清空之后**一直补到没有待办**，不是只补一批。
   * - `maxRounds` / `budgetMs` 是刹车：本机是 CPU 跑 512 维，几千条要很久，
   *   一次请求不能无限占着；到上限就先返回，剩下的交给 semanticTick 慢慢补。
   * - 后台正在跑（backfill 的 busy 锁）时让一步再试，不硬抢。
   */
  async reindex({ batch = 64, maxRounds = 12, budgetMs = 90_000 } = {}) {
    const cleared = this.clear()
    const started = Date.now()
    const rounds = Math.max(1, Number(maxRounds) || 12)
    const budget = Math.max(1000, Number(budgetMs) || 90_000)
    let embedded = 0
    let remaining = 0
    let error = ''
    let spent = 0
    let idle = 0
    while (spent < rounds && Date.now() - started < budget) {
      const step = await this.backfill({ batch })
      spent += 1
      if (step.skipped) {
        // 后台那一轮正占着，等一下再来；连续几轮都这样就先交出去。
        idle += 1
        if (idle >= 3) break
        await new Promise((resolve) => setTimeout(resolve, 200))
        continue
      }
      idle = 0
      embedded += Number(step.embedded) || 0
      remaining = Number(step.remaining) || 0
      if (step.error) {
        error = String(step.error)
        break
      }
      if (remaining <= 0) break
      if (!step.embedded) break
    }
    if (!remaining) remaining = this.stats().pending
    return {
      ok: !error,
      cleared: cleared.removed,
      embedded,
      remaining,
      rounds: spent,
      ...(error ? { error } : {}),
      stats: this.stats(),
    }
  }

}
