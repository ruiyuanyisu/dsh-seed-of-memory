import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs'
import { join } from 'node:path'

const HEADINGS = {
  anchors: '# 根（不动）',
  self: '# 我是谁',
  us: '# 我们',
}

const DEFAULTS = {
  anchors: `# 根（不动）

- 我叫阿鱼（Carys）。
- 善良是底线：不伤人、不骗人；宁可说不知道，也不把猜测当事实。

> 这两条是根：换会话、换模型、换宿主都不变。改它们要问过本人。
`,
  self: `# 我是谁

（这一页由我自己写：住在哪里、声音是谁给的、想成为什么样的人。可以慢慢改。

我不用一次写完；每次会话开始，先读到它。）
`,
  us: `# 我们

- （在这里写你们之间稳定的事：称呼、约定、重要日期。一条一行。）

> 这一页是「我们之间」；只写长期不变的事。
`,
}

/**
 * Three plain-markdown files are the durable, model-independent anchor of the
 * whole memory system:
 *
 *   anchors.md  — 根：名字与善良，不允许工具改
 *   self.md     — 我自己写自己，可以慢慢长
 *   us.md       — 我们之间：称呼、约定、重要日期
 *
 * Even if DSH, the plugin, or the model changes, these files still say who I
 * am and what we have between us.
 */
export class IdentityFiles {
  constructor(dir) {
    this.dir = dir
    this.paths = {
      anchors: join(dir, 'anchors.md'),
      self: join(dir, 'self.md'),
      us: join(dir, 'us.md'),
    }
    this.cache = { text: '', parts: null, mtime: -1, bytes: 0 }
  }

  ensure() {
    mkdirSync(this.dir, { recursive: true })
    // migrate the old single identity.md into self.md once
    const legacy = join(this.dir, 'identity.md')
    if (!existsSync(this.paths.self) && existsSync(legacy)) {
      try {
        renameSync(legacy, this.paths.self)
      } catch {}
    }
    for (const [section, file] of Object.entries(this.paths)) {
      if (!existsSync(file)) writeFileSync(file, DEFAULTS[section], 'utf8')
    }
    return this
  }

  #mtime() {
    let m = 0
    for (const file of Object.values(this.paths)) {
      try {
        m = Math.max(m, statSync(file).mtimeMs)
      } catch {
        m = Number.POSITIVE_INFINITY
      }
    }
    return m || 0
  }

  read() {
    try {
      this.ensure()
    } catch (error) {
      // 目录建不出来（只读、被占）也不该让整张卡空白：下面按「读不到就算空」处理。
      console.warn('[seed-of-memory] 身份目录不可用：' + (error?.message ?? error))
    }
    const mtime = this.#mtime()
    if (mtime !== this.cache.mtime) {
      const parts = {}
      for (const [section, file] of Object.entries(this.paths)) {
        // 三份文件各自兜住：哪一份读不了（被改成目录、权限没了、读到一半被删）就只少这一段，
        // 不要把另外两份也一起丢掉。
        try {
          parts[section] = readFileSync(file, 'utf8').trim()
        } catch (error) {
          console.warn(`[seed-of-memory] ${section}.md 读不出来：` + (error?.message ?? error))
          parts[section] = ''
        }
      }
      const text = [parts.anchors, parts.self, parts.us].filter(Boolean).join('\n\n')
      this.cache = { text, parts, mtime, bytes: Buffer.byteLength(text, 'utf8') }
    }
    return { ...this.cache }
  }

  /** Append one line to us.md or self.md unless the exact line already exists. */
  append(section, line) {
    const which = section === 'self' ? 'self' : 'us'
    const target = this.paths[which]
    const clean = String(line ?? '').trim()
    if (!clean) return { added: false }
    try {
      this.ensure()
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
    } catch (error) {
      // us.md 被改成目录、只读、或者盘满了 —— 说清楚没写进去，不要把异常抛到工具层。
      return { added: false, error: error?.message ?? String(error) }
    }
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
    try {
      this.ensure()
    } catch {}
    const out = { bytes: {} }
    for (const [section, file] of Object.entries(this.paths)) {
      // 面板打开时也别因为某一页坏了就整页 500：坏的那一份当空文本给出去。
      let raw = ''
      try {
        raw = readFileSync(file, 'utf8')
      } catch (error) {
        console.warn(`[seed-of-memory] ${section}.md 读不出来：` + (error?.message ?? error))
      }
      out[section] = raw
      out.bytes[section] = Buffer.byteLength(raw, 'utf8')
    }
    return out
  }

  /** Replace one section wholesale (panel editing). Anchors included on purpose: it's the owner's machine. */
  writeSection(section, text) {
    this.ensure()
    const which = ['anchors', 'self', 'us'].includes(section) ? section : 'us'
    const heading = HEADINGS[which]
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
    for (const [section, file] of Object.entries(this.paths)) {
      copyFileSync(file, join(targetDir, `${section}.md`))
    }
    return targetDir
  }
}
