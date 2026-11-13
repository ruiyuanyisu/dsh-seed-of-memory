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

export class QqHistory {
  constructor(file, { maxTurns = MAX_TURNS, maxKeys = MAX_KEYS } = {}) {
    this.file = String(file ?? '').trim()
    this.maxTurns = Math.max(1, Number(maxTurns) || MAX_TURNS)
    this.maxKeys = Math.max(1, Number(maxKeys) || MAX_KEYS)
    this.data = new Map()
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
        if (!Array.isArray(turns) || turns.length === 0) continue
        this.data.set(
          key,
          turns
            .filter((turn) => turn && (turn.u || turn.a))
            .slice(-this.maxTurns)
            .map((turn) => ({ u: String(turn.u ?? ''), a: String(turn.a ?? ''), t: Number(turn.t) || 0 })),
        )
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
    const text = { u: clip(u), a: clip(a), t: Date.now() }
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

  clear(key) {
    this.load()
    if (this.data.delete(key)) this.#save()
    return this
  }

  /** 拼成给模型看的一小段「刚才」。没有就返回空串。 */
  recap(key, limit = 6) {
    const turns = this.get(key, limit)
    if (turns.length === 0) return ''
    const lines = []
    for (const turn of turns) {
      if (turn.u) lines.push('老大：' + turn.u)
      if (turn.a) lines.push('你：' + turn.a)
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
