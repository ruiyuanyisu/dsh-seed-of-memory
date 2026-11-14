/**
 * 和其他记忆插件打交道：认得出它们、读得动它们、搬得过来。
 *
 * 原则：
 * - 只读。绝不去改别人家的数据文件。
 * - 默认什么都不做。没有装别的记忆插件时，这里一行都不会被调用到。
 * - 读不懂也不硬猜：能拿到多少算多少，返回的每条都带「从哪来的」。
 */

import fs from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { normalizeText } from './store.js'

const MAX_FILES = 300
const MAX_BYTES = 8 * 1024 * 1024
const MAX_RECORDS = 5000
const TEXT_KEYS = ['text', 'content', 'memory', 'statement', 'body', 'summary', 'value', 'fact', 'note']
const TIME_KEYS = ['at', 'createdAt', 'created_at', 'time', 'ts', 'timestamp', 'updatedAt', 'updated_at', 'date']
const IMPORTANCE_KEYS = ['importance', 'weight', 'score']
const TAG_KEYS = ['tags', 'related', 'keywords']
const CATEGORY_KEYS = ['category', 'type', 'kind', 'layer', 'scope']

export const SOURCES = [
  {
    id: 'fish-memory',
    name: '鱼的记忆（dsh-fish-memory）',
    pkg: 'dsh-fish-memory',
    repo: 'https://github.com/Yuuyuko-uu/dsh-fish-memory',
    kind: 'fish',
    blurb: '扁平 JSON，每条带时间',
    dirs: (env) => [join(env.dshHome, 'fish-memory')],
  },
  {
    id: 'lite-memory',
    name: 'dsh-lite-memory',
    pkg: 'dsh-lite-memory',
    repo: 'https://github.com/regrevia/dsh-lite-memory',
    kind: 'json',
    blurb: '按项目分 state.json，平时不常驻',
    dirs: (env) => [join(env.dshHome, 'lite-memory')],
  },
  {
    id: 'meow-memory',
    name: 'meow-memory',
    pkg: 'meow-memory',
    repo: 'https://github.com/Phant0Meow/dsh-meow-memory',
    kind: 'sqlite',
    blurb: '七层 SQLite：soul/user/project/fact/lesson/topic/rules',
    dirs: (env) => [join(env.home, '.dsh-meow'), join(env.dshHome, 'meow-memory')],
  },
  {
    id: 'auto-memory',
    name: 'dsh-auto-memory',
    pkg: 'dsh-auto-memory',
    repo: 'https://github.com/AskTheWay/dsh-auto-memory',
    kind: 'markdown',
    blurb: 'Markdown 记忆文件 + MEMORY.md 索引',
    dirs: (env) => [join(env.dshHome, 'auto-memory'), join(env.home, '.claude', 'projects')],
  },
  {
    id: 'memory-doctor',
    name: '深鲸记忆（dsh-memory-doctor）',
    pkg: 'dsh-memory-doctor',
    repo: 'https://github.com/feely0208/dsh-memory-doctor',
    kind: 'markdown',
    blurb: 'MEMORY / USER 两个 markdown',
    dirs: (env) => [join(env.dshHome, 'memory-doctor'), join(env.dshHome, 'memory')],
  },
  {
    id: 'mnemon',
    name: 'dsh-mnemon',
    pkg: 'dsh-mnemon',
    repo: 'https://github.com/omdsh-dev/dsh-mnemon',
    kind: 'json',
    blurb: '视图式上下文，数据目录可自选（这里是默认位置）',
    dirs: (env) => [join(env.dshHome, 'mnemon')],
  },
]

export function defaultEnv(overrides = {}) {
  const home = overrides.home ?? homedir()
  const dshHome = overrides.dshHome ?? (process.env.DSH_HOME || join(home, '.dsh'))
  const profileDir = overrides.profileDir ?? (process.env.DSH_PROFILE_DIR || '')
  return { home, dshHome, profileDir }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function listFiles(dir, filter, limit = MAX_FILES) {
  const out = []
  const walk = (current, depth) => {
    if (out.length >= limit || depth > 4) return
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= limit) return
      if (/^(node_modules|\.git|\.svn|dist|backup|备份)$/i.test(entry.name)) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else if (entry.isFile() && filter(entry.name)) {
        out.push(full)
      }
    }
  }
  walk(dir, 0)
  return out.sort()
}

function smallRead(file) {
  try {
    const stat = fs.statSync(file)
    if (stat.size > MAX_BYTES) return null
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function findSource(id) {
  return SOURCES.find((source) => source.id === id) ?? null
}

function packageInstalled(env, pkg) {
  if (!env.profileDir) return false
  return isFile(join(env.profileDir, 'node_modules', pkg, 'package.json'))
}

function existingDirs(env, source) {
  try {
    return source.dirs(env).filter((dir) => isDir(dir))
  } catch {
    return []
  }
}

// ---------- 通用取字段 ----------

function pickString(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

function pickNumber(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  }
  return null
}

function pickTime(obj) {
  for (const key of TIME_KEYS) {
    const value = obj?.[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value < 1e11 ? value * 1000 : value
    if (typeof value === 'string' && value.trim()) {
      const parsed = Date.parse(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

function pickList(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key]
    if (Array.isArray(value)) {
      const list = value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
      if (list.length) return list
    }
  }
  return []
}

function recordFrom(obj, extra = {}) {
  const text = pickString(obj, TEXT_KEYS).trim()
  if (text.length < 4) return null
  return {
    text: text.length > 400 ? text.slice(0, 400) : text,
    at: pickTime(obj),
    category: pickString(obj, CATEGORY_KEYS),
    importance: pickNumber(obj, IMPORTANCE_KEYS),
    tags: pickList(obj, TAG_KEYS),
    ...extra,
  }
}

/** 深挖 JSON 里长得像「一条记忆」的对象。读不懂就当没有。 */
function collectFromJson(value, out, depth = 0) {
  if (out.length >= MAX_RECORDS || depth > 6 || value === null) return
  if (Array.isArray(value)) {
    for (const item of value) collectFromJson(item, out, depth + 1)
    return
  }
  if (typeof value !== 'object') return
  const record = recordFrom(value)
  if (record) {
    out.push(record)
    return
  }
  for (const item of Object.values(value)) {
    if (item && typeof item === 'object') collectFromJson(item, out, depth + 1)
  }
}

function readFishFiles(dir, sourceId) {
  const records = []
  const notes = []
  for (const file of listFiles(dir, (name) => name.endsWith('.json') && !name.endsWith('.bak'))) {
    const raw = smallRead(file)
    if (!raw) continue
    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      notes.push(`${basename(file)} 读不动（不是合法 JSON）`)
      continue
    }
    const list = Array.isArray(parsed?.memories) ? parsed.memories : []
    for (const item of list) {
      const record = recordFrom(item, { file: basename(file), ref: String(item?.id ?? ''), from: sourceId })
      if (record) records.push(record)
    }
    if (!list.length) notes.push(`${basename(file)} 里没找到 memories`)
  }
  return { records, notes }
}

function readJsonFiles(dirs, sourceId) {
  const records = []
  const notes = []
  for (const dir of dirs) {
    for (const file of listFiles(dir, (name) => name.endsWith('.json'))) {
      const raw = smallRead(file)
      if (!raw) continue
      let parsed = null
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }
      const before = records.length
      collectFromJson(parsed, records)
      for (let index = before; index < records.length; index += 1) {
        records[index].file = basename(file)
        records[index].from = sourceId
      }
    }
  }
  if (!records.length) notes.push('这些目录里的 JSON 没有看起来像记忆的条目')
  return { records, notes }
}

function readMarkdownFiles(dirs, sourceId) {
  const records = []
  const notes = []
  for (const dir of dirs) {
    for (const file of listFiles(dir, (name) => /\.md$/i.test(name))) {
      if (/^MEMORY\.md$/i.test(basename(file))) continue
      const raw = smallRead(file)
      if (!raw) continue
      let body = raw
      const meta = {}
      const front = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
      if (front) {
        body = raw.slice(front[0].length)
        for (const line of front[1].split(/\r?\n/)) {
          const match = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.+)$/)
          if (match) meta[match[1]] = match[2].replace(/^["']|["']$/g, '').trim()
        }
      }
      const bodyText = text0(body)
      // 记忆文件多半是一条一行：有列表就一条一条拆，没有就整篇当一条。
      const bullets = raw
        .split(/\r?\n/)
        .filter((line) => /^\s*(?:[-*+]|\d+\.)\s+\S/.test(line))
        .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').trim())
        .filter((line) => line.length >= 4)
      const chunks = bullets.length
        ? bullets
        : [bodyText || text0(meta.description)].filter((chunk) => chunk && chunk.length >= 4)
      for (const chunk of chunks) {
        records.push({
          text: chunk.length > 400 ? chunk.slice(0, 400) : chunk,
          at: pickTime(meta) ?? pickTime({ at: safeStat(file) }),
          category: meta.type ?? meta.category ?? '',
          importance: pickNumber(meta, IMPORTANCE_KEYS),
          tags: pickList(meta, TAG_KEYS),
          file: basename(file),
          from: sourceId,
        })
      }
    }
  }
  if (!records.length) notes.push('没找到可读的 markdown 记忆')
  return { records, notes }
}

function text0(value) {
  if (typeof value !== 'string') return ''
  const clean = value
    .replace(/^#+\s*/gm, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .trim()
  return clean
}

function safeStat(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return null
  }
}

function readSqliteDbs(dirs, sourceId) {
  const records = []
  const notes = []
  let DatabaseSync = null
  try {
    ;({ DatabaseSync } = requireSqlite())
  } catch (error) {
    return { records, notes: ['这个运行时没有 node:sqlite，读不了 SQLite 记忆'] }
  }
  for (const dir of dirs) {
    const dbs = listFiles(dir, (name) => /\.(db|sqlite|sqlite3)$/i.test(name))
    for (const file of dbs) {
      let db = null
      try {
        db = new DatabaseSync(file, { readOnly: true })
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all()
          .map((row) => row.name)
        for (const table of tables) {
          const before = records.length
          const rows = db.prepare(`SELECT * FROM "${table}" LIMIT 2000`).all()
          for (const row of rows) {
            const record = recordFrom(row, { file: basename(file), ref: String(row.id ?? ''), from: sourceId })
            if (record) records.push({ ...record, category: record.category || String(row.layer ?? table) })
          }
          if (records.length === before) continue
        }
      } catch (error) {
        notes.push(`${basename(file)} 读不动：${error?.message ?? error}`)
      } finally {
        try {
          db?.close()
        } catch {}
      }
    }
  }
  return { records, notes }
}

function requireSqlite() {
  // node:sqlite 是内置模块，用 createRequire 同步拿（Electron-as-node 和 Node 22+ 都认）。
  // 之前用动态 import() 忘了 await，结果一直「读不了 SQLite」，这里改成同步。
  return createRequire(import.meta.url)('node:sqlite')
}

/** 数一下某个目录下有多少条（轻量，只读标题级别的信息）。 */
function countRecords(source, dirs) {
  try {
    if (source.kind === 'markdown') {
      let total = 0
      for (const dir of dirs) {
        for (const file of listFiles(dir, (name) => /\.md$/i.test(name) && !/^MEMORY\.md$/i.test(name), 200)) {
          const raw = smallRead(file)
          if (!raw) continue
          const bullets = raw.split(/\r?\n/).filter((line) => /^\s*(?:[-*+]|\d+\.)\s+\S/.test(line)).length
          total += bullets || 1
        }
      }
      return total
    }
    if (source.kind === 'sqlite') {
      let total = 0
      let DatabaseSync = null
      try {
        ;({ DatabaseSync } = requireSqlite())
      } catch {
        return 0
      }
      for (const dir of dirs) {
        for (const file of listFiles(dir, (name) => /\.(db|sqlite|sqlite3)$/i.test(name), 20)) {
          let db = null
          try {
            db = new DatabaseSync(file, { readOnly: true })
            const tables = db
              .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
              .all()
              .map((row) => row.name)
            for (const table of tables) {
              const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()
              total += Number(row?.n) || 0
            }
          } catch {
            // 读不动就算了，别让一个坏库把 detect 拖垮
          } finally {
            try {
              db?.close()
            } catch {}
          }
        }
      }
      return total
    }
    let total = 0
    for (const dir of dirs) {
      for (const file of listFiles(dir, (name) => name.endsWith('.json') && !name.endsWith('.bak'), 100)) {
        const raw = smallRead(file)
        if (!raw) continue
        try {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed?.memories)) total += parsed.memories.length
        } catch {}
      }
    }
    return total
  } catch {
    return 0
  }
}

// ---------- 对外 ----------

/** 认一下现场：装了谁、数据在不在、大概多少条。 */
export function detect(env = defaultEnv()) {
  return SOURCES.map((source) => {
    const dirs = existingDirs(env, source)
    const installed = packageInstalled(env, source.pkg) || dirs.length > 0
    const count = dirs.length ? countRecords(source, dirs) : 0
    return {
      id: source.id,
      name: source.name,
      kind: source.kind,
      blurb: source.blurb,
      repo: source.repo,
      installed,
      // 空目录不算「有数据」：别家卸载后留下的空文件夹不该让我们让出卡片预算。
      hasData: count > 0,
      count,
      dirs,
    }
  })
}

/** 除了我们之外，还有谁在现场，而且真的有数据。 */
export function othersActive(env = defaultEnv()) {
  return detect(env).filter((row) => row.id !== 'seed-of-memory' && row.hasData)
}

/** 共存时卡片预算：别家在场就按比例让一点（最低 200），只有我们时一分不让。 */
export function sharedBudget(base, ratio, others = []) {
  const total = Number(base) || 600
  if (!Array.isArray(others) || others.length === 0) return total
  const raw = Number(ratio)
  const safe = Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.6
  return Math.max(200, Math.round(total * safe))
}

/** 读一个来源的全部记录。只读，不改任何文件。 */
export async function readSource(id, env = defaultEnv()) {
  const source = findSource(id)
  if (!source) throw new Error(`不认识的来源：${id}`)
  const dirs = existingDirs(env, source)
  if (!dirs.length) return { id, name: source.name, records: [], notes: ['没找到数据目录（可能没装或者还没写过）'] }
  let result
  if (source.kind === 'fish') result = readFishFiles(dirs[0], id)
  else if (source.kind === 'markdown') result = readMarkdownFiles(dirs, id)
  else if (source.kind === 'sqlite') result = readSqliteDbs(dirs, id)
  else result = readJsonFiles(dirs, id)
  return { id, name: source.name, records: result.records, notes: result.notes, dirs }
}

function layerFor(category) {
  const value = String(category ?? '').toLowerCase()
  if (/fact|preference|prefs|profile|persona|user|soul|rule|习惯|偏好|身份/.test(value)) return 'semantic'
  return 'episodic'
}

/** 把读出来的记录写进 Seed。重复的并、新的插，绝不硬造 factKey。 */
export function importRecords(store, records, { sourceId = 'compat', dryRun = false } = {}) {
  const seen = new Set()
  const report = { read: records.length, unique: 0, added: 0, merged: 0, other: 0, sample: [] }
  for (const record of records) {
    const text = String(record?.text ?? '').trim()
    if (text.length < 4) continue
    const norm = normalizeText(text)
    if (seen.has(norm)) continue
    seen.add(norm)
    report.unique += 1
    if (report.sample.length < 5) report.sample.push(text.slice(0, 60))
    if (dryRun) continue
    try {
      const result = store.remember({
        text,
        layer: layerFor(record.category),
        source: 'import',
        confidence: 0.6,
        importance: Math.max(0.3, Math.min(1, Number(record.importance) || 0.5)),
        occurredAt: record.at ?? null,
        scope: 'shared',
        meta: {
          compat: sourceId,
          from: record.from ?? sourceId,
          file: record.file ?? null,
          ref: record.ref ?? null,
          tags: record.tags ?? [],
        },
      })
      if (result.action === 'inserted') report.added += 1
      else if (result.action === 'merged') report.merged += 1
      else report.other += 1
    } catch {
      report.other += 1
    }
  }
  return report
}

const EXPORT_ORDER = ['persona', 'semantic', 'episodic', 'buffer']

/** 导出成中性格式：JSONL 一行一条，或者 markdown 摘要。 */
export function exportSnapshot(store, { format = 'jsonl', limit = 2000, scope = null } = {}) {
  const rows = store.list({ limit, includeRetired: true })
  const sorted = rows
    .slice()
    .sort((a, b) => EXPORT_ORDER.indexOf(a.layer) - EXPORT_ORDER.indexOf(b.layer) || b.recorded_at - a.recorded_at)
    .filter((row) => !scope || row.scope === scope)
  if (format === 'md') {
    const lines = ['# 记忆导出', `\n导出时间：${new Date().toISOString()}`, `条数：${sorted.length}`, '']
    for (const layer of EXPORT_ORDER) {
      const group = sorted.filter((row) => row.layer === layer)
      if (!group.length) continue
      lines.push(`## ${layer}（${group.length}）`, '')
      for (const row of group) {
        const when = new Date(row.recorded_at).toISOString().slice(0, 10)
        lines.push(`- ${row.text}  _(${when} · ${row.source} · ${Number(row.confidence ?? 0).toFixed(2)})_`)
      }
      lines.push('')
    }
    return lines.join('\n')
  }
  return sorted
    .map((row) =>
      JSON.stringify({
        id: row.id,
        text: row.text,
        layer: row.layer,
        source: row.source,
        scope: row.scope,
        confidence: row.confidence,
        importance: row.importance,
        factKey: row.fact_key,
        status: row.status,
        recordedAt: row.recorded_at,
        occurredAt: row.occurred_at ?? null,
        supersededBy: row.superseded_by ?? null,
      }),
    )
    .join('\n')
}
