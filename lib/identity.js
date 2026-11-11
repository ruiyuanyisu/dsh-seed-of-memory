import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

const IDENTITY_FILE = 'identity.md'
const US_FILE = 'us.md'

const DEFAULT_IDENTITY = `# 我是谁

（在这里写：你叫什么、住在哪里、声音是谁给的、想成为什么样的人。）

这一页只写「我是谁」。每次会话开始，先读到它。
`

const DEFAULT_US = `# 我们

- （在这里写你们之间稳定的事：称呼、约定、重要日期。一条一行。）

> 这一页是「我们之间」；只写长期不变的事。
`

/**
 * Identity files are the durable, model-independent anchor of the whole
 * memory system: even if DSH, the plugin, or the model changes, these two
 * plain markdown files still say who I am and what we have between us.
 */
export class IdentityFiles {
  constructor(dir) {
    this.dir = dir
    this.paths = {
      identity: join(dir, IDENTITY_FILE),
      us: join(dir, US_FILE),
    }
    this.cache = { text: '', mtime: -1, bytes: 0 }
  }

  ensure() {
    mkdirSync(this.dir, { recursive: true })
    if (!existsSync(this.paths.identity)) writeFileSync(this.paths.identity, DEFAULT_IDENTITY, 'utf8')
    if (!existsSync(this.paths.us)) writeFileSync(this.paths.us, DEFAULT_US, 'utf8')
    return this
  }

  #mtime() {
    let m = 0
    for (const file of Object.values(this.paths)) {
      try {
        m = Math.max(m, statSync(file).mtimeMs)
      } catch {
        // missing file: treat as changed so the next read recreates it
        m = Number.POSITIVE_INFINITY
      }
    }
    return m || 0
  }

  read() {
    this.ensure()
    const mtime = this.#mtime()
    if (mtime !== this.cache.mtime) {
      const identity = readFileSync(this.paths.identity, 'utf8').trim()
      const us = readFileSync(this.paths.us, 'utf8').trim()
      const text = [identity, us].filter(Boolean).join('\n\n')
      this.cache = { text, mtime, bytes: Buffer.byteLength(text, 'utf8') }
    }
    return { ...this.cache }
  }

  /** Append one line to us.md (or identity.md) unless the exact line already exists. */
  append(section, line) {
    this.ensure()
    const target = section === 'identity' ? this.paths.identity : this.paths.us
    const clean = String(line ?? '').trim()
    if (!clean) return { added: false }
    const lines = readFileSync(target, 'utf8').split(/\r?\n/)
    if (lines.some((row) => row.trim() === `- ${clean}`)) return { added: false }
    const bullet = `- ${clean}`
    let insertAt = -1
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].trimStart().startsWith('- ')) {
        insertAt = i + 1
        break
      }
    }
    if (insertAt >= 0) lines.splice(insertAt, 0, bullet)
    else lines.push(bullet)
    writeFileSync(target, lines.join('\n').replace(/\n{3,}$/, '\n\n'), 'utf8')
    this.cache.mtime = -1
    return { added: true }
  }

  /** Rewrite us.md's bullet list, used by /seed us replace. */
  replaceUs(lines) {
    this.ensure()
    const body = lines.map((line) => `- ${String(line).trim()}`).join('\n')
    writeFileSync(this.paths.us, `# 我们\n\n${body}\n`, 'utf8')
    this.cache.mtime = -1
    return this.read()
  }

  /** Raw text of each file, for the settings panel editor. */
  readRaw() {
    this.ensure()
    const identity = readFileSync(this.paths.identity, 'utf8')
    const us = readFileSync(this.paths.us, 'utf8')
    return {
      identity,
      us,
      bytes: {
        identity: Buffer.byteLength(identity, 'utf8'),
        us: Buffer.byteLength(us, 'utf8'),
      },
    }
  }

  /** Replace one section wholesale (panel editing). Heading is kept/restored. */
  writeSection(section, text) {
    this.ensure()
    const which = section === 'identity' ? 'identity' : 'us'
    const heading = which === 'identity' ? '# 我是谁' : '# 我们'
    const raw = String(text ?? '').replace(/\r\n/g, '\n').trim()
    if (!raw) throw new Error('内容不能为空')
    if (Buffer.byteLength(raw, 'utf8') > 8000) throw new Error('内容过长（上限 8000 字节）')
    const body = raw.startsWith('#') ? raw : `${heading}\n\n${raw}`
    writeFileSync(this.paths[which], body.endsWith('\n') ? body : `${body}\n`, 'utf8')
    this.cache.mtime = -1
    return this.readRaw()
  }

  exportTo(targetDir) {
    mkdirSync(targetDir, { recursive: true })
    for (const [key, file] of Object.entries(this.paths)) {
      copyFileSync(file, join(targetDir, key === 'identity' ? IDENTITY_FILE : US_FILE))
    }
    return targetDir
  }
}
