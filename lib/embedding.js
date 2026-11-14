// Seed of Memory — 本地语义检索运行时管理器
// 负责：发现下载到的安装包、解压安装、启停 Ollama 运行时、调用 /api/embed。
// 设计原则：失败不抛到插件层（只返回 { ok:false, error }），没有运行时自动退回纯 FTS。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PACK_MARKER = 'seed-embed-runtime'
const ZIP_PATTERN = /^seed-embed-runtime.*\.zip$/i
const DEFAULT_PORT = 11435
const START_TIMEOUT_MS = 40_000
const PROBE_TIMEOUT_MS = 1_500

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function probeJson(url, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 常见的“用户下载目录”集合。 */
export function downloadDirs(home = os.homedir()) {
  return [
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
  ]
}

/**
 * 启动时要不要自动装/拉 embedding 运行时。
 * 语义检索关掉的时候就别折腾：解压一份运行时要几百兆，起了还常驻内存。
 */
export function autoInitEnabled(config = {}) {
  return config?.semanticEnabled !== false
}

export class EmbeddingRuntime {
  constructor({ stateDir, port = DEFAULT_PORT, logger = console, extraScanDirs = [], home = os.homedir() } = {}) {
    this.stateDir = stateDir
    this.home = home
    this.root = path.join(stateDir, 'embedding-runtime')
    this.exe = path.join(this.root, 'runtime', 'ollama.exe')
    this.models = path.join(this.root, 'runtime', 'ollama-models')
    this.pidFile = path.join(stateDir, 'embedding-runtime.json')
    this.port = Number(port) || DEFAULT_PORT
    this.logger = logger
    this.extraScanDirs = extraScanDirs
    this.child = null
    this.lastError = ''
    this.installing = false
  }

  get endpoint() {
    return `http://127.0.0.1:${this.port}`
  }

  get installed() {
    return fs.existsSync(this.exe) && fs.existsSync(this.models)
  }

  versionInfo() {
    return readJsonFile(path.join(this.root, 'VERSION.json'))
  }

  async reachable() {
    const tags = await probeJson(`${this.endpoint}/api/tags`)
    return Array.isArray(tags?.models) ? tags.models : null
  }

  async status() {
    const models = this.installed ? await this.reachable() : null
    const info = this.versionInfo()
    return {
      installed: this.installed,
      running: Boolean(models),
      endpoint: this.endpoint,
      port: this.port,
      model: info?.modelTag ?? 'bge-small-zh-v1.5:latest',
      dimension: Number(info?.dimension) || 512,
      version: info?.version ?? null,
      models: (models ?? []).map((m) => m.name),
      installedAt: info?.builtAt ?? null,
      lastError: this.lastError || null,
    }
  }

  /** 扫描下载目录里像安装包的 zip。 */
  scan() {
    const dirs = [...new Set([...downloadDirs(this.home), ...this.extraScanDirs])]
    const found = []
    for (const dir of dirs) {
      let entries = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile() || !ZIP_PATTERN.test(entry.name)) continue
        const file = path.join(dir, entry.name)
        try {
          const stat = fs.statSync(file)
          if (stat.size < 10 * 1024 * 1024) continue // 明显不是完整包
          found.push({ path: file, name: entry.name, bytes: stat.size, mtime: stat.mtimeMs })
        } catch {}
      }
    }
    return found.sort((a, b) => b.mtime - a.mtime)
  }

  /** 校验并解压安装。zipPath 可以是扫描结果里的路径。 */
  async install(zipPath) {
    if (this.installing) return { ok: false, error: '安装正在进行中' }
    const file = String(zipPath ?? '')
    if (!file || !fs.existsSync(file)) return { ok: false, error: '安装包不存在' }
    const size = fs.statSync(file).size
    if (size < 10 * 1024 * 1024) return { ok: false, error: '安装包不完整（小于 10MB）' }

    this.installing = true
    const tmp = path.join(this.stateDir, `.embedding-install-${Date.now()}`)
    try {
      fs.mkdirSync(tmp, { recursive: true })
      const extracted = await this.extract(file, tmp)
      if (!extracted.ok) return { ok: false, error: extracted.error }

      const info = readJsonFile(path.join(tmp, 'VERSION.json'))
      if (!info || info.pack !== PACK_MARKER) return { ok: false, error: '不是 Seed Embedding Runtime 安装包' }
      const exe = path.join(tmp, 'runtime', 'ollama.exe')
      const models = path.join(tmp, 'runtime', 'ollama-models')
      if (!fs.existsSync(exe)) return { ok: false, error: '安装包缺少 runtime/ollama.exe' }
      if (!fs.existsSync(models)) return { ok: false, error: '安装包缺少 runtime/ollama-models' }

      if (await this.reachable()) await this.stop().catch(() => {})
      const old = `${this.root}.old`
      if (fs.existsSync(old)) fs.rmSync(old, { recursive: true, force: true })
      if (fs.existsSync(this.root)) fs.renameSync(this.root, old)
      fs.mkdirSync(path.dirname(this.root), { recursive: true })
      fs.renameSync(tmp, this.root)
      if (fs.existsSync(old)) fs.rmSync(old, { recursive: true, force: true })
      this.lastError = ''
      this.logger.info?.(`[seed-of-memory] 已安装 embedding runtime → ${this.root}`)
      return { ok: true, installed: true, version: info.version, model: info.model }
    } catch (error) {
      this.lastError = String(error?.message ?? error)
      return { ok: false, error: this.lastError }
    } finally {
      this.installing = false
      try {
        if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true })
      } catch {}
    }
  }

  extract(zip, dest) {
    return new Promise((resolve) => {
      const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      const bin = fs.existsSync(tar) ? tar : 'tar'
      const child = spawn(bin, ['-xf', zip, '-C', dest], { windowsHide: true })
      let stderr = ''
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      child.on('error', () => {
        // 兜底：用 PowerShell Expand-Archive
        const ps = spawn('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`,
        ], { windowsHide: true })
        ps.on('error', (error) => resolve({ ok: false, error: `解压失败：${error?.message ?? error}` }))
        ps.on('exit', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: `解压失败（PowerShell exit ${code}）` }))
      })
      child.on('exit', (code) => {
        if (code === 0) return resolve({ ok: true })
        resolve({ ok: false, error: `解压失败（tar exit ${code}）${stderr.slice(0, 200)}` })
      })
    })
  }

  async start() {
    if (!this.installed) return { ok: false, error: '还没有安装本地检索运行时' }
    const tags = await this.reachable()
    if (tags) return { ok: true, running: true, external: true, endpoint: this.endpoint }

    const child = spawn(this.exe, ['serve'], {
      cwd: path.join(this.root, 'runtime'),
      env: {
        ...process.env,
        OLLAMA_HOST: `127.0.0.1:${this.port}`,
        OLLAMA_MODELS: this.models,
        OLLAMA_KEEP_ALIVE: '30m',
      },
      windowsHide: true,
      stdio: 'ignore',
    })
    this.child = child
    child.on('exit', () => {
      if (this.child === child) this.child = null
    })

    const until = Date.now() + START_TIMEOUT_MS
    while (Date.now() < until) {
      const models = await this.reachable()
      if (models) {
        try {
          fs.writeFileSync(this.pidFile, JSON.stringify({ pid: child.pid, port: this.port, endpoint: this.endpoint, startedAt: Date.now() }))
        } catch {}
        this.lastError = ''
        return { ok: true, running: true, endpoint: this.endpoint, pid: child.pid }
      }
      await sleep(400)
    }
    this.lastError = '运行时启动超时'
    try {
      child.kill()
    } catch {}
    return { ok: false, error: this.lastError }
  }

  async stop() {
    let pid = this.child?.pid
    if (!pid) {
      const info = readJsonFile(this.pidFile)
      pid = Number(info?.pid) || 0
    }
    if (pid) {
      try {
        process.kill(pid)
      } catch {}
    }
    try {
      fs.rmSync(this.pidFile, { force: true })
    } catch {}
    await sleep(500)
    const tags = await this.reachable()
    return { ok: !tags, running: Boolean(tags) }
  }

  /** 调 Ollama 原生接口取向量；失败返回 { ok:false }。 */
  async embed(texts, model = 'bge-small-zh-v1.5:latest') {
    const input = (Array.isArray(texts) ? texts : [texts]).map((text) => String(text ?? ''))
    if (!input.length || input.some((text) => !text.trim())) return { ok: false, error: '空文本' }
    try {
      const response = await fetch(`${this.endpoint}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input }),
        signal: AbortSignal.timeout(120_000),
      })
      if (!response.ok) return { ok: false, error: `embed HTTP ${response.status}` }
      const body = await response.json()
      const vectors = Array.isArray(body?.embeddings) ? body.embeddings : null
      if (!vectors || vectors.length !== input.length) return { ok: false, error: '返回数量不符' }
      return { ok: true, vectors, model, dimension: vectors[0]?.length ?? 0 }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }
}
