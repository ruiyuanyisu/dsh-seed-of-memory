/**
 * 消息工具：把 OneBot 的 message（array 或 CQ 字符串）拆成段落，
 * 以及拿到 DSH 的 createUserMessage（拿不到就用同形状的本地兜底）。
 *
 * 为什么要动态拿：桌面版 profile 不装 @deepseek-ai/* 的 peer，
 * 直接 `import '@deepseek-ai/dsh-llm'` 会让整个插件在加载期失败；
 * 但宿主自己的 asar 里一定有这个包，所以按候选路径一个个试。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 本地兜底：与 dsh-llm 的 createUserMessage 同形状。 */
export function fallbackUserMessage({ content, source = { kind: 'user' } }) {
  return { content, source, role: 'user', id: randomUUID() }
}

function hostRoots() {
  const roots = []
  const env = process.env.DSH_HOST_MODULES
  if (env) roots.push(env)
  const exeDir = process.execPath ? dirname(process.execPath) : ''
  if (exeDir) {
    roots.push(join(exeDir, 'resources', 'app.asar', 'dsh', 'node_modules'))
    roots.push(join(exeDir, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules'))
    roots.push(join(exeDir, 'resources', 'app', 'dsh', 'node_modules'))
  }
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  roots.push(join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node_modules'))
  roots.push(join(home, 'profiles', process.env.DSH_PROFILE || 'desktop', 'node_modules'))
  return roots
}

let factoryPromise = null

/** 惰性拿 createUserMessage；全失败就退回本地实现。 */
export function userMessageFactory() {
  if (!factoryPromise) {
    factoryPromise = (async () => {
      for (const root of hostRoots()) {
        const dir = join(root, '@deepseek-ai', 'dsh-llm')
        try {
          if (!existsSync(join(dir, 'package.json'))) continue
          const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
          const entry = pkg.exports?.['.']?.default ?? pkg.exports?.['.'] ?? pkg.main ?? 'lib/index.js'
          const file = typeof entry === 'string' ? join(dir, entry) : join(dir, 'lib', 'index.js')
          const mod = await import(pathToFileURL(file).href)
          if (typeof mod.createUserMessage === 'function') return mod.createUserMessage
        } catch {
          /* try next root */
        }
      }
      return fallbackUserMessage
    })()
  }
  return factoryPromise
}

/** 把 message 规范成 [{ type, data }]，两种格式都吃。 */
export function segmentsOf(message) {
  if (Array.isArray(message)) return message.map((s) => ({ type: String(s?.type ?? ''), data: s?.data ?? {} }))
  if (typeof message !== 'string') return []
  const out = []
  const parts = message.split(/(\[CQ:[^\]]+\])/)
  for (const part of parts) {
    if (!part) continue
    if (!part.startsWith('[CQ:')) {
      out.push({ type: 'text', data: { text: part } })
      continue
    }
    const inner = part.slice(4, -1)
    const comma = inner.indexOf(',')
    const type = comma < 0 ? inner : inner.slice(0, comma)
    const data = {}
    if (comma >= 0) {
      for (const pair of inner.slice(comma + 1).split(',')) {
        const eq = pair.indexOf('=')
        if (eq > 0) data[pair.slice(0, eq)] = pair.slice(eq + 1)
      }
    }
    out.push({ type, data })
  }
  return out
}

export function textOf(segments) {
  return segments
    .filter((s) => s.type === 'text')
    .map((s) => String(s.data?.text ?? ''))
    .join('')
    .replace(/\u2005/g, ' ')
    .trim()
}

export function mentionedSelf(segments, selfId) {
  const self = String(selfId ?? '')
  if (!self) return false
  return segments.some((s) => s.type === 'at' && String(s.data?.qq ?? '') === self)
}

export function faceOf(segments) {
  return segments
    .filter((s) => s.type === 'face' && s.data?.id)
    .map((s) => String(s.data.id))
}

/**
 * 图片段。OneBot 给的形状是 `{type:'image', data:{file, url, sub_type}}`，
 * 但 file 可能是本地路径、也可能是 QQ 那边的文件名（要 get_image 才换得到）。
 */
export function imageSegments(segments) {
  return segments.filter((s) => s.type === 'image')
}


/**
 * 他是不是在要一条语音： 「发一条语音吧」「说句话听听」「唱一个」。
 * 只是提到「语音识别」「语音功能」这种不算——动词和「语音/声音/唱」要挨得近。
 */
export function wantsVoice(text) {
  const body = String(text ?? '').trim()
  if (!body) return false
  // 「我发了一条语音给你」是在说他自己的动作，不是在要。
  if (/我(?!们)[^。！？!?\n]{0,4}(发|录|传)了?[^。！？!?\n]{0,6}(语音|声音)/.test(body)) return false
  const hit = /(发|来|说|唱|念|录)[^。！？!?\n]{0,6}(语音|声音|一[条段句首个下遍]|听听)/.exec(body)
  if (!hit) return false
  // 「别发语音了」「不用发了」是明确不要——别顺着字面去发。
  const before = body.slice(Math.max(0, hit.index - 4), hit.index)
  if (/(别|不要|不用|甭|勿|不必)\s*$/.test(before)) return false
  return true
}
