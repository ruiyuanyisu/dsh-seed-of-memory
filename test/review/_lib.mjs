/**
 * 审查包（守岸人 pack-阿鱼/tools/测试）那 24 个脚本搬过来用的公共零件。
 *
 * 为什么要搬：那套脚本问的都是「分人之后有没有串」这类真问题，
 * 但他的 PKG 常量硬写死了他自己机器上的安装路径，也没法在源码上跑。
 * 这里一个原脚本对应一个文件，只把「调用哪个函数」换成我 1.5.0 的真实接口，
 * 问的问题不变；我故意做得和他不一样的（心情只一份、群档按群不按人），
 * 断言按我的语义写，文件头注明差异。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { closeDatabase, openDatabase, SCHEMA_VERSION } from '../../lib/db.js'
import { SeedStore } from '../../lib/store.js'
import { Qing } from '../../lib/qing.js'
import { QqChannel } from '../../lib/qq/channel.js'
import { QqHistory } from '../../lib/qq/history.js'
import { fallbackUserMessage } from '../../lib/qq/message.js'

export { assert, QqChannel, QqHistory, Qing, fallbackUserMessage }

/** 仓库根：E:\cz\seed-of-memory */
export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
export const SCHEMA = SCHEMA_VERSION

export function pass(name) {
  console.log(`PASS ${name}`)
}

/** 读一份源码（只给「这段代码长什么样」的静态检查用）。 */
export function src(rel) {
  return readFileSync(join(ROOT, rel), 'utf8')
}

export function mkStore(prefix = 'seed-review-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const file = join(dir, 'seed.db')
  const db = openDatabase(file)
  const store = new SeedStore(db, { dbPath: file })
  return { db, store, dir, file }
}

export function drop(ctx) {
  try {
    closeDatabase(ctx.db)
  } catch {}
  rmSync(ctx.dir, { recursive: true, force: true })
}

export function rows(db, sql, ...params) {
  return db.prepare(sql).all(...params)
}

export function one(db, sql, ...params) {
  return db.prepare(sql).get(...params)
}

export function hasTable(db, name) {
  return Boolean(
    one(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name),
  )
}

export function hasIndex(db, name) {
  return Boolean(
    one(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?", name),
  )
}

export function columns(db, table) {
  return rows(db, `PRAGMA table_info(${table})`).map((r) => r.name)
}

/* ---------------------------------------------------------------- QQ 侧零件 */

export class FakeClient extends EventEmitter {
  constructor() {
    super()
    this.connected = false
    this.calls = []
    this.selfId = '10000'
  }

  status() {
    return { connected: this.connected, selfId: this.selfId }
  }

  connect() {
    this.connected = true
  }

  close() {
    this.connected = false
  }

  async call(action, params) {
    this.calls.push({ action, params })
    return { status: 'ok', data: { message_id: this.calls.length } }
  }
}

export function fakeAgents({ reply = '好的，我记住了。' } = {}) {
  const agents = new Map()
  const created = []
  const state = { channel: null }
  return {
    created,
    state,
    get(id) {
      return agents.get(id) ?? null
    },
    async resume() {
      throw new Error('no session')
    },
    async create({ sessionId }) {
      const agent = {
        followup(message) {
          created.push({ sessionId, message })
          setTimeout(() => {
            state.channel?.onSessionEvent(
              { header: { id: sessionId } },
              { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } },
            )
          }, 5)
        },
        async whenIdle() {},
      }
      agents.set(sessionId, agent)
      let disposed = false
      return {
        agent,
        dispose() {
          if (disposed) return
          disposed = true
          agents.delete(sessionId)
        },
      }
    },
  }
}

export function makeChannel({ config = {}, agents = fakeAgents(), client = new FakeClient(), onLog, attachWorkspace = null, history = null } = {}) {
  const merged = {
    ...QqChannel.defaults(),
    enabled: true,
    allowPrivate: ['10001'],
    allowGroups: ['123456'],
    debounceMs: 0,
    ...config,
  }
  const channel = new QqChannel({
    client,
    agents,
    config: merged,
    logger: { log() {}, warn() {}, error() {}, debug() {} },
    onLog,
    attachWorkspace,
    history,
  })
  agents.state.channel = channel
  return { channel, client, agents }
}

/** 造一条私聊事件。 */
export function privateEvent({ userId = 10001, text = '帮我记住我喜欢夜里听雨', messageId = 1 } = {}) {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: 10000,
    user_id: userId,
    message_id: messageId,
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
  }
}

/** 造一条群消息事件。 */
export function groupEvent({ groupId = 123456, userId = 20001, card = '张三', text = '今天下雨了', messageId = 1 } = {}) {
  return {
    post_type: 'message',
    message_type: 'group',
    self_id: 10000,
    group_id: groupId,
    user_id: userId,
    message_id: messageId,
    raw_message: text,
    sender: { user_id: userId, card, nickname: card },
    message: [
      { type: 'at', data: { qq: '10000' } },
      { type: 'text', data: { text } },
    ],
  }
}
