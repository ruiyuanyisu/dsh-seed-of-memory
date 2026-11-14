import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * External memory sources are opt-in: by default nothing outside the database
 * is scanned. Configure them either in the plugin config (`sources: [...]`) or
 * in `~/.dsh/seed-of-memory/sources.json` (see EXAMPLE_SOURCES for the shape).
 */
export const DEFAULT_SOURCES = []

export const EXAMPLE_SOURCES = [
  {
    id: 'my-notes',
    label: '旧笔记',
    root: '~/notes',
    include: ['长期.md', '日记/**'],
    exclude: ['备份/**'],
  },
]

const MAX_FILE_BYTES = 4 * 1024 * 1024
const CHUNK_CHARS = 520

function toPosix(value) {
  return String(value).replace(/\\/g, '/')
}

export function globToRegExp(glob) {
  const source = toPosix(glob)
  let out = ''
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index]
    if (ch === '*') {
      if (source[index + 1] === '*') {
        out += '.*'
        index += 1
        if (source[index + 1] === '/') index += 1
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += '\\' + ch
    } else {
      out += ch
    }
  }
  return new RegExp('^' + out + '$')
}

function matchesAny(rel, globs) {
  return (globs || []).some((glob) => globToRegExp(glob).test(rel))
}

export function chunkContent(content, maxChars = CHUNK_CHARS) {
  const lines = String(content ?? '').split(/\r?\n/)
  const chunks = []
  let buffer = []
  let start = 1
  let chars = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (buffer.length === 0) start = index + 1
    buffer.push(line)
    chars += line.length + 1
    if (chars >= maxChars) {
      const text = buffer.join('\n').trim()
      if (text) chunks.push({ line: start, text })
      buffer = []
      chars = 0
    }
  }
  if (buffer.length) {
    const text = buffer.join('\n').trim()
    if (text) chunks.push({ line: start, text })
  }
  return chunks
}

function snippet(text, width = 140) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > width ? flat.slice(0, width) + '…' : flat
}

function ftsQuery(value) {
  return '"' + String(value).replace(/"/g, '""') + '"'
}

export class ExternalIndex {
  constructor(db, sources = DEFAULT_SOURCES) {
    this.db = db
    this.sources = (sources || []).filter((source) => source && source.root && existsSync(source.root))
    this.lastScan = 0
    this.lastStats = { files: 0, chunks: 0, skipped: 0 }
  }

  roots() {
    return this.sources.map((source) => path.resolve(source.root))
  }

  insideRoot(target) {
    const resolved = path.resolve(target)
    const lower = resolved.toLowerCase()
    return this.roots().some((root) => {
      const base = root.toLowerCase()
      return lower === base || lower.startsWith(base + path.sep)
    })
  }

  listFiles() {
    const found = []
    const walk = (source, dir) => {
      let entries = []
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name)
        const rel = toPosix(path.relative(source.root, abs))
        if (entry.isDirectory()) {
          if (matchesAny(rel, source.exclude) || matchesAny(rel + '/x', source.exclude)) continue
          if ((source.exclude || []).some((glob) => glob.startsWith(rel + '/'))) continue
          walk(source, abs)
          continue
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
        if (matchesAny(rel, source.exclude)) continue
        if (source.include?.length && !matchesAny(rel, source.include)) continue
        found.push({ source, abs, rel })
      }
    }
    for (const source of this.sources) walk(source, path.resolve(source.root))
    return found
  }

  scan({ force = false } = {}) {
    let files = 0
    let chunks = 0
    let skipped = 0
    const now = Date.now()
    const seen = new Set()
    for (const item of this.listFiles()) {
      seen.add(item.abs)
      let info
      try {
        info = statSync(item.abs)
      } catch {
        continue
      }
      if (info.size > MAX_FILE_BYTES) {
        skipped += 1
        continue
      }
      const known = this.db.prepare('SELECT mtime, size FROM ext_files WHERE path = ?').get(item.abs)
      if (!force && known && Number(known.mtime) === Math.round(info.mtimeMs) && Number(known.size) === info.size) {
        skipped += 1
        continue
      }
      let content
      try {
        content = readFileSync(item.abs, 'utf8')
      } catch {
        skipped += 1
        continue
      }
      const pieces = chunkContent(content)
      this.db.prepare('DELETE FROM ext_chunks WHERE path = ?').run(item.abs)
      const insert = this.db.prepare('INSERT INTO ext_chunks (path, line, text) VALUES (?, ?, ?)')
      for (const piece of pieces) insert.run(item.abs, piece.line, piece.text)
      this.db
        .prepare(
          `INSERT INTO ext_files (path, root, mtime, size, chunks, scanned_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size,
             chunks = excluded.chunks, scanned_at = excluded.scanned_at`,
        )
        .run(item.abs, item.source.id, Math.round(info.mtimeMs), info.size, pieces.length, now)
      files += 1
      chunks += pieces.length
    }
    // 盘上已经删掉（或改名、改成太大的）的文件，索引里也要跟着退场：
    // 只清「这次确实走过的根」里的路径，别误伤暂时没挂上的盘。
    let pruned = 0
    for (const row of this.db.prepare('SELECT path FROM ext_files').all()) {
      if (seen.has(row.path) || !this.insideRoot(row.path)) continue
      this.db.prepare('DELETE FROM ext_chunks WHERE path = ?').run(row.path)
      this.db.prepare('DELETE FROM ext_files WHERE path = ?').run(row.path)
      pruned += 1
    }
    this.lastScan = now
    this.lastStats = { files, chunks, skipped, pruned }
    return { ...this.lastStats, at: now }
  }

  search(query, { limit = 4 } = {}) {
    const text = String(query ?? '').trim()
    if (!text) return []
    const max = Math.max(1, Math.min(20, Number(limit) || 4))
    let rows = []
    try {
      if ([...text].length >= 3) {
        rows = this.db
          .prepare(
            `SELECT path, line, text, bm25(ext_chunks) AS score
             FROM ext_chunks WHERE ext_chunks MATCH ? ORDER BY score LIMIT ?`,
          )
          .all(ftsQuery(text), max)
      } else {
        rows = this.db
          .prepare('SELECT path, line, text, 0 AS score FROM ext_chunks WHERE text LIKE ? LIMIT ?')
          .all('%' + text + '%', max)
      }
    } catch {
      rows = []
    }
    return rows.map((row) => {
      const source = this.sources.find((item) => this.db.prepare('SELECT root FROM ext_files WHERE path = ?').get(row.path)?.root === item.id)
      let rel = row.path
      if (source) rel = toPosix(path.relative(source.root, row.path))
      return {
        path: row.path,
        sourceId: source?.id ?? '',
        label: source?.label ?? '档案',
        rel,
        line: Number(row.line) || 1,
        snippet: snippet(row.text),
        score: Number(row.score) || 0,
      }
    })
  }

  readAround(target, { line = 1, chars = 1200 } = {}) {
    const abs = path.resolve(target)
    if (!this.insideRoot(abs)) throw new Error('这个路径不在允许的档案根里')
    if (!existsSync(abs)) throw new Error('文件不存在：' + abs)
    const info = statSync(abs)
    if (info.size > MAX_FILE_BYTES) throw new Error('文件太大，不展开')
    const content = readFileSync(abs, 'utf8')
    const lines = content.split(/\r?\n/)
    const start = Math.max(1, Number(line) || 1) - 6
    const from = Math.max(1, start)
    let text = ''
    for (let index = from - 1; index < lines.length; index += 1) {
      text += (text ? '\n' : '') + lines[index]
      if (text.length >= chars) break
    }
    return { path: abs, line: from, text: text.slice(0, chars) }
  }

  stats() {
    const files = this.db.prepare('SELECT COUNT(*) AS n FROM ext_files').get()
    const chunks = this.db.prepare('SELECT COUNT(*) AS n FROM ext_chunks').get()
    return {
      sources: this.sources.map((source) => ({ id: source.id, label: source.label, root: source.root })),
      files: Number(files?.n ?? 0),
      chunks: Number(chunks?.n ?? 0),
      lastScan: this.lastScan,
      lastStats: this.lastStats,
    }
  }
}
