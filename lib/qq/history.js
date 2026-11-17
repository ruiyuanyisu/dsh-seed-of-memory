/**
 * QQ 会话的小账本：把最近几轮对话存在插件自己的状态目录里。
 *
 * 为什么不靠 resume：宿主里 `sessionPersistence` 对插件 `agents.create`
 * 建出来的 QQ 会话写不进磁盘（只有 subagent 那种会话会落盘），所以每次重启
 * 都是新会话、resume 必然 not found。QQ 要「记得刚才聊到哪」，只能自己存。
 *
 * 只存很短的一截：每个 key（私聊/群）最近 maxTurns 轮，最多 maxKeys 个 key。
 * 丢了也无所谓——它是给「重启后接上话」用的，不是记忆本体（记忆在 seed.db）。
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs'

const MAX_TURNS = 8
const MAX_KEYS = 40
const SAVE_DELAY = 500
const MAX_TEXT = 400

function clip(text) {
  const value = String(text ?? '').trim().replace(/\s+/g, ' ')
  return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) + '…' : value
}

/**
 * 把 `[语音]…` 那几行摘掉，只留正文。
 *
 * 为什么在这儿再写一份（channel.js 里已经有 splitVoiceNote）：那边 import 了
 * 本文件，本文件反过来 import 它就成环了。这里只要「删掉整行」这一件事，
 * 不值得为它把依赖关系搞乱。
 */
function stripVoiceLines(text) {
  const raw = String(text ?? '')
  if (!raw || !/(?:\[语音\]|【语音】)/.test(raw)) return raw.trim()
  // 两种形态都要认：
  //  - 还带着换行的老数据：删整行；
  //  - 已经被 clip() 压成一行的老数据（行首那个标记跑到中间去了）：
  //    从标记处一直切到尾——它本来就在正文最后。
  return raw
    .replace(/^[ \t]*(?:\[语音\]|【语音】)[ \t]*(.*)$/gm, '')
    .replace(/[ \t]*(?:\[语音\]|【语音】)[\s\S]*$/, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export class QqHistory {
  constructor(file, { maxTurns = MAX_TURNS, maxKeys = MAX_KEYS } = {}) {
    this.file = String(file ?? '').trim()
    this.maxTurns = Math.max(1, Number(maxTurns) || MAX_TURNS)
    this.maxKeys = Math.max(1, Number(maxKeys) || MAX_KEYS)
    this.data = new Map()
    // key -> 宿主里的 sessionId。QQ 会话在宿主持久化里留不下来，但它换过一次 id
    // （坏记录换新、cwd 变了重建）之后，得记住现在用的是哪个，否则每次重启都重开一份。
    this.sessions = new Map()
    // 坏掉的会话 id（宿主 resume/create 都会炸的那种）。只活在内存里的话，
    // 每次重启后第一条消息都要再撞一次，聊天慢一拍——所以跟账本一起存。
    this.broken = new Set()
    this.loaded = false
    this.timer = null
    this.dirty = false
  }

  load() {
    if (this.loaded) return this
    this.loaded = true
    if (!this.file) return this
    try {
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      const keys = parsed && typeof parsed === 'object' ? parsed : {}
      for (const [key, turns] of Object.entries(keys)) {
        // `__sessions` / `__broken` 这些下划线开头的不是聊天 key，别当账本读进来。
        if (key.startsWith('__')) continue
        if (!Array.isArray(turns) || turns.length === 0) continue
        this.data.set(
          key,
          turns
            .filter((turn) => turn && (turn.u || turn.a))
            .slice(-this.maxTurns)
            .map((turn) => ({ u: String(turn.u ?? ''), a: String(turn.a ?? ''), t: Number(turn.t) || 0 })),
        )
      }
      const broken = keys.__broken
      if (Array.isArray(broken)) {
        for (const id of broken) {
          const value = String(id ?? '').trim()
          if (value) this.broken.add(value)
        }
      }
      const sessions = keys.__sessions
      if (sessions && typeof sessions === 'object') {
        for (const [key, id] of Object.entries(sessions)) {
          const value = String(id ?? '').trim()
          if (key && value) this.sessions.set(key, value)
        }
      }
    } catch {
      /* 第一次跑、文件坏了、没权限：都当成空账本 */
    }
    return this
  }

  #evict() {
    while (this.data.size > this.maxKeys) {
      this.data.delete(this.data.keys().next().value)
    }
  }

  /** 记一轮：他说了什么、回了他什么。 */
  append(key, { u = '', a = '' } = {}) {
    this.load()
    const text = { u: clip(u), a: clip(stripVoiceLines(a)), t: Date.now() }
    if (!text.u && !text.a) return this
    const turns = this.data.get(key) ?? []
    turns.push(text)
    if (turns.length > this.maxTurns) turns.splice(0, turns.length - this.maxTurns)
    this.data.delete(key)
    this.data.set(key, turns)
    this.#evict()
    this.#save()
    return this
  }

  get(key, limit = this.maxTurns) {
    this.load()
    const turns = this.data.get(key) ?? []
    return turns.slice(-Math.max(1, Number(limit) || this.maxTurns))
  }

  /** 这个 key 现在挂在哪个 sessionId 上（没记过返回空串）。 */
  sessionOf(key) {
    this.load()
    return String(this.sessions.get(key) ?? '')
  }

  /** 记住这个 key 现在用哪个 sessionId（换过一次 id 之后尤其重要）。 */
  mapSession(key, id) {
    this.load()
    const value = String(id ?? '').trim()
    if (!key || !value) return this
    if (this.sessions.get(key) === value) return this
    this.sessions.set(key, value)
    while (this.sessions.size > this.maxKeys) {
      this.sessions.delete(this.sessions.keys().next().value)
    }
    this.#save()
    return this
  }

  /** 记过哪些 id 是坏的（重启后接着用）。 */
  brokenIds() {
    this.load()
    return [...this.broken]
  }

  markBroken(id) {
    this.load()
    const value = String(id ?? '').trim()
    if (!value || this.broken.has(value)) return this
    this.broken.add(value)
    while (this.broken.size > 50) {
      this.broken.delete(this.broken.values().next().value)
    }
    this.#save()
    return this
  }

  clear(key) {
    this.load()
    const a = this.data.delete(key)
    const b = this.sessions.delete(key)
    if (a || b) this.#save()
    return this
  }

  /** 拼成给模型看的一小段「刚才」。没有就返回空串。 */
  recap(key, limit = 6) {
    const turns = this.get(key, limit)
    if (turns.length === 0) return ''
    const lines = []
    for (const turn of turns) {
      if (turn.u) lines.push('老大：' + turn.u)
      // 老账本里可能还留着 `[语音]…` 那行（那时候还没把它摘掉）。
      // 不清理的话，复盘时会把「说给耳朵听的那句」当成说过的话再提一遍。
      // 这里内联一份去掉它的正则，不引 channel.js——那边引着本文件，会成环。
      if (turn.a) lines.push('你：' + stripVoiceLines(turn.a))
    }
    if (lines.length === 0) return ''
    return (
      '[刚才] 这些是重启前你们聊过的最后几句（不是新消息，别当成他在提问）：\n' +
      lines.join('\n') +
      '\n接着往下说就行，已经说过的别再重复一遍。'
    )
  }

  #save() {
    if (!this.file) return
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, SAVE_DELAY)
    this.timer.unref?.()
  }

  flush() {
    if (!this.file || !this.dirty) return false
    this.dirty = false
    try {
      const payload = {}
      for (const [key, turns] of this.data) payload[key] = turns
      if (this.sessions.size > 0) {
        const map = {}
        for (const [key, id] of this.sessions) map[key] = id
        payload.__sessions = map
      }
      if (this.broken.size > 0) payload.__broken = [...this.broken]
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(payload), 'utf8')
      renameSync(tmp, this.file)
      return true
    } catch {
      /* 状态目录不可写时别把 QQ 弄挂 */
      return false
    }
  }

  dispose() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.flush()
    this.data.clear()
  }
}
