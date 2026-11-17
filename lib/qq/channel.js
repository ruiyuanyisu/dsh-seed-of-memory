/**
 * QQ 通道：把 SnowLuma 的 OneBot 事件变成 DSH 的一轮对话，再把回复发回去。
 *
 * 设计成「一个 QQ 会话（私聊/群）对应一个 Agent」：
 *   - 私聊 `private:<qq>`，群聊 `group:<群号>`；
 *   - sessionId 由 key 的 sha1 决定，所以宿主重启后能 resume 回同一段历史；
 *   - 同一个 peer 串行处理，避免两轮回复撞在一起；
 *   - 只回白名单里的人/群，群里默认要 @ 才理。
 *
 * 它不负责人格与记忆：Agent 一旦被创建，Seed 的卡片注入会自动铺上去，
 * 所以「QQ 和本地记忆串起来」这件事，靠的就是「QQ 会话也是普通 Agent 会话」。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { QqHistory } from './history.js'
import { segmentsOf, textOf, mentionedSelf, imageSegments, userMessageFactory, wantsVoice } from './message.js'
import { decideGroupReply, bumpGroupStats, GROUP_DEFAULTS } from './group.js'
import { normalizeQqConfig } from './settings.js'
import { routeOf, normalizeScope, isOrder } from './routes.js'
import { VoiceProbe, VOICE_NOTICE } from '../voice.js'
import {
  recordSegments,
  resolveRecordFile,
  resolveImageFile,
  transcribeFile,
  synthesizeToFile,
  looksSpeakable,
  voiceFileName,
  audioSize,
  pruneVoiceFiles,
} from './media.js'

const MAX_LOG = 30
const SEEN_LIMIT = 400
const MAX_REPLY_CHARS = 1200
// 网关/宿主自己的报错（resume failed、RemoteError…）。它既不该当回复发出去，
// 也不该被当成「他说的话」记一遍。
const INTERNAL_ERROR_TEXT = /消息未被接受|gateway\/internal|RemoteError|never started|resume failed|session persistence/i

/**
 * 这一条到底是不是宿主吐出来的报错。
 *
 * 只看关键词会误杀：人会问「RemoteError 是什么梗」，会把「session persistence」当术语念。
 * 宿主报错是英文标识符加堆栈，人话里有相当比例的汉字——先看汉字占比，
 * 超过一成半就认定是人在说话（宁可放过一条报错，也不吞一句人话）。
 */
function looksLikeInternalError(text) {
  const value = String(text ?? '')
  if (!INTERNAL_ERROR_TEXT.test(value)) return false
  const cjk = (value.match(/[\u4e00-\u9fff]/g) ?? []).length
  const visible = value.replace(/\s/g, '').length || 1
  if (cjk / visible > 0.15) return false
  return true
}

function sha1(text) {
  return createHash('sha1').update(String(text)).digest('hex')
}

function chunkText(text, size = MAX_REPLY_CHARS) {
  const out = []
  let rest = String(text ?? '').trim()
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size * 0.5) cut = size
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out.filter(Boolean)
}

/** 把一段回复拆成「像人连发几条」的气泡：按句号/换行切，单条不超过 size，最多 max 条。 */
// 一句话里一个句号都没有、或者整段粘在一起时，也得能切成能发出去的小段，
// 不然 QQ 那边可能直接拒收（一条消息太长）。
function hardSplit(text, size) {
  const out = []
  let rest = String(text ?? '').trim()
  const marks = ['\n', '。', '！', '？', '；', '，', '、', ' ', '\t']
  while (rest.length > size) {
    let cut = -1
    for (const mark of marks) {
      const at = rest.lastIndexOf(mark, size)
      if (at > size * 0.4) {
        cut = at + 1
        break
      }
    }
    if (cut <= 0) cut = size
    const head = rest.slice(0, cut).trim()
    if (head) out.push(head)
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out
}

const QUOTE_OPEN = new Set(['「', '『', '“', '‘', '（', '(', '【', '《', '〈', '[', '{'])
const QUOTE_CLOSE = new Set(['」', '』', '”', '’', '）', ')', '】', '》', '〉', ']', '}'])

/**
 * 按句末标点切段，但引号/括号里的标点不算断句：
 * 「他说：好。然后呢」不该被切成两句。
 */
export function splitOutsideQuotes(text) {
  const raw = String(text ?? '')
  const out = []
  let depth = 0
  let cur = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    cur += ch
    if (QUOTE_OPEN.has(ch)) depth += 1
    else if (QUOTE_CLOSE.has(ch)) depth = Math.max(0, depth - 1)
    if (depth > 0) continue
    // 刚开的引号后面不切（「」这类成对出现时上面已经把 depth 抬起来了）
    if (/[。！？!?…～~；;\n]/.test(ch)) {
      out.push(cur)
      cur = ''
    }
  }
  if (cur) out.push(cur)
  return out
}

export function splitBubbles(text, max = 3, size = 90) {
  const raw = String(text ?? '').trim()
  if (!raw) return []
  const cap = Math.max(1, Number(size) || 90)
  // 一整段没有标点时，宁可发几条长一点的，也别拆成一长串小消息刷屏；
  // 但单条要留在 QQ 收得下的范围里。
  const wide = Math.min(1000, Math.max(cap * 8, 600))
  const maxBubbles = Math.max(3, Math.floor(Number(max) || 3) + 2)
  if (max <= 1) return hardSplit(raw, wide)
  const pieces = splitOutsideQuotes(raw)
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => (part.length > wide ? hardSplit(part, wide) : [part]))
  if (pieces.length <= 1) return hardSplit(raw, wide)
  const groups = []
  let cur = ''
  for (const piece of pieces) {
    if (!cur) cur = piece
    else if (cur.length + piece.length <= cap) cur += piece
    else {
      groups.push(cur)
      cur = piece
    }
  }
  if (cur) groups.push(cur)
  if (groups.length <= max) return groups
  // 剩下的合并起来，但别让它变成一条超长消息。
  const merged = groups.slice(max - 1).join('')
  const tail = merged.length > wide ? hardSplit(merged, wide) : [merged]
  const result = [...groups.slice(0, max - 1), ...tail]
  if (result.length <= maxBubbles) return result
  // 还是太碎（比如一整段五千字没有任何标点）：换成宽度更大的切法，
  // 条数压到能接受的范围，内容一个字都不丢。
  const wider = Math.min(1200, Math.max(wide, Math.ceil(raw.length / maxBubbles)))
  const regrouped = hardSplit(raw, wider)
  return regrouped.length ? regrouped : result
}

// 收尾的寒暄：单独一条「晚安」「好呀」发出去很吵，宁可少说这一句。
const TAIL_CLOSING =
  /^(好|好的|好呀|好咯|行|行吧|嗯+|哦|晚安|晚安啦|早点睡|睡吧|加油|那就这样|先这样|有事再叫我|随时叫我|哈哈|嘿嘿|收到|知道了)[。！!～~…\s]*$/

// 结尾单独一句寒暄（前面有正文时）：整句去掉，别让它占掉最后一条气泡。
const TAIL_SENTENCE =
  /(?:^|(?<=[。！？!?…～~；;\n]))\s*(?:好|好的|好呀|好咯|行|行吧|嗯+|哦|晚安|晚安啦|早点睡|睡吧|加油|那就这样|先这样|有事再叫我|随时叫我|哈哈|嘿嘿|收到|知道了)[。！!～~…\s]*$/

/** 收尾沉默（整句版）：去掉结尾那句纯寒暄；去掉后正文太短就不动。 */
export function trimTailText(text) {
  const raw = String(text ?? '')
  const hit = raw.match(TAIL_SENTENCE)
  if (!hit) return raw
  const rest = raw.slice(0, hit.index).trim()
  return rest.length >= 4 ? rest : raw
}

// 单独说给耳朵听的那句：正文里另起一行，`[语音]`（或【语音】）后面到行尾。
const VOICE_NOTE_RE = /^[ \t]*(?:\[语音\]|【语音】)[ \t]*(.*)$/gm

/**
 * 把 `[语音]…` 那几行从正文里摘出来。
 * 摘出来的部分只念、不跟着正文发；正文里不留下这一行。
 * 没写就返回空 say，调用方退回「念整段正文」的老行为。
 */
/** 每轮都附在消息末尾的一小段。 */
const QQ_TURN_NOTE =
  '\n\n[这一轮] 你在 QQ 上说话：短、口语，不要 Markdown、别贴路径或命令。' +
  '回复的最后另起一行，写一句 `[语音]` 开头的——用嘴说的那句，和正文不一样，60 字以内。' +
  '（私聊每轮都写；群里看场合，不用每句都出声。）' +
  '对方发来图片时，消息里会带一行 `[图片] 路径`——先用 read_image 打开看一眼，再照着图说话；' +
  '不许说「没打开」「只看到个文件名」。'

export function splitVoiceNote(text) {
  const raw = String(text ?? '')
  const notes = []
  const body = raw.replace(VOICE_NOTE_RE, (_, said) => {
    const line = String(said ?? '').trim()
    if (line) notes.push(line)
    return ''
  })
  const cleaned = body
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { body: cleaned, say: notes.join(' ').trim() }
}

/**
 * 收尾沉默：最后一条只是寒暄时，干脆不发。
 * 只在这种情况下丢：至少还有一条正文，且最后一条很短、纯寒暄。
 */
export function trimTailBubbles(bubbles) {
  const list = Array.isArray(bubbles) ? [...bubbles] : []
  while (list.length > 1) {
    const last = String(list[list.length - 1] ?? '').trim()
    if (last.length <= 8 && TAIL_CLOSING.test(last)) {
      list.pop()
      continue
    }
    break
  }
  return list
}

/**
 * 没听懂的时候该怎么回：先说「没听清」，别让人对着空气说话。
 * @returns {'' | 'unavailable' | 'hear-failed'}
 */
export function voiceFallback({ text = '', unhearable = false, asrFailed = false } = {}) {
  if (text) return ''
  if (unhearable) return 'unavailable'
  if (asrFailed) return 'hear-failed'
  return ''
}

/**
 * 语音的频率：off 不发；always 每次回都发；auto 每 every 次回一条（默认 3）。
 * 注意这只是「加不加一条语音」，文字永远都会发。
 */
export function voiceCadence({ mode = 'auto', turns = 0, every = 3 } = {}) {
  const m = String(mode ?? 'auto').toLowerCase()
  if (m === 'off' || m === 'false') return false
  if (m === 'always' || m === 'true') return true
  const n = Math.max(1, Number(every) || 3)
  return Number(turns) > 0 && Number(turns) % n === 0
}

/** 两条路径是不是同一个（大小写、斜杠、尾部分隔符都不计较）。 */
export function samePath(a, b) {
  const norm = (value) =>
    String(value ?? '')
      .trim()
      .replace(/\//g, '\\')
      .replace(/\\+$/, '')
      .toLowerCase()
  const left = norm(a)
  const right = norm(b)
  return Boolean(left) && left === right
}

function sleep(ms) {  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function textOfMessage(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('')
    .trim()
}

export class QqChannel {
  constructor({ client, agents, config = {}, logger = console, onLog = null, getMood = null, history = null, attachWorkspace = null, onAsked = null, onReplied = null, attachments = null }) {
    this.client = client
    this.agents = agents
    // 宿主的 attachment store：QQ 发来的图要靠它变成真正的 image block，
    // 不然精简工具集里没有 read_image，模型只能干看着一个路径。
    this.attachments = attachments
    // 手改 qq.json 时最常见的三种手抖（数组写成字符串、布尔写成 "false"、数字写成字符串）
    // 在这里收一次，免得「白名单全挡掉」「只听不回反而回」这种沉默的怪行为。
    this.config = normalizeQqConfig(config)
    this.logger = logger
    this.onLog = onLog
    this.getMood = getMood
    this.records = new Map()
    this.waiters = new Map()
    this.seen = new Set()
    this.entries = []
    this.started = false
    this.lastInboundAt = 0
    this.lastInboundAtBefore = 0
    this.groupStats = new Map()
    this.myMessageIds = new Set()
    this.voiceProbe = new VoiceProbe()
    /** 上一次真把语音发出去的时间：探活误报时用来兜底。 */
    this.ttsHealthyAt = 0
    this.voiceNotices = new Map()
    this.ttsWarnAt = 0
    this.lastStatus = ''
    this.resumeMissed = new Set()
    this.freshSessions = new Set()
    // 旧会话记录本身坏掉（比如它当初挂的插件后来被禁用，resume 会一直报 never started）
    // 时，同一个 id 就别再试了，换新的 id 建。
    this.brokenSessions = new Set()
    // 这个 key 下一次要重开一份新会话（/reset、或者配置里的 cwd 变了）。
    this.rotateNext = new Set()
    // 同一个 key 的会话正在建的时候，别两条消息各建一份（QQ 里连着发两句就会撞上）。
    this.ensuring = new Map()
    // 连着发来的几条，先攒一小会儿再合成一轮（私聊防抖）。
    this.pending = new Map()
    // 路由层：最近的「命令」、每个会话的记忆档。
    this.orders = []
    this.scopes = new Map()
    // 会话 id → 这个人是谁（熟人卡、未完话头都要按人取）
    this.peers = new Map()
    this.routeWarned = new Set()
    this.onAsked = typeof onAsked === 'function' ? onAsked : null
    this.onReplied = typeof onReplied === 'function' ? onReplied : null
    this.attachWorkspace = typeof attachWorkspace === 'function' ? attachWorkspace : null
    this.history = history ?? new QqHistory(config.historyFile ?? '')
    // 坏会话名单跟着账本一起存，重启之后第一条消息不用再撞一次坏 id。
    try {
      this.brokenSessions = new Set(this.history?.brokenIds?.() ?? [])
    } catch {
      /* 账本读不了就当空的 */
    }
  }

  /** 重启后新会话的第一条消息：把「刚才聊到哪」补进去，只补一次。 */
  freshRecap(sessionId, limit = 6) {
    const id = String(sessionId ?? '')
    if (!id || !this.freshSessions.has(id)) return ''
    this.freshSessions.delete(id)
    let key = ''
    for (const record of this.records.values()) {
      if (record.sessionId === id) {
        key = record.key
        break
      }
    }
    if (!key) return ''
    try {
      return this.history.recap(key, limit)
    } catch {
      return ''
    }
  }

  static defaults() {
    return {
      enabled: false,
      wsUrl: 'ws://127.0.0.1:3001',
      httpUrl: 'http://127.0.0.1:3000',
      accessToken: '',
      allowPrivate: [],
      allowGroups: [],
      groupRequireAt: true,
      autoReply: true,
      ownerQQ: '',
      burstMax: 3,
      burstGapMs: 900,
      ...GROUP_DEFAULTS,
      cwd: '',
      provider: '',
      model: '',
      reasoningEffort: '',
      voiceIn: true,
      voiceOut: 'auto',
      voiceMaxChars: 80,
      // auto 模式下每几次回一条语音（3 = 隔两次发一次；文字每次都发）
      voiceEvery: 3,
      voiceDir: '',
      // 图片：收下来存到本地，再把路径写进消息里（模型拿路径自己去读）
      imageIn: true,
      imageDir: '',
      // 常驻 ASR 服务（模型预先加载好，一条语音两秒）。填了就先问它，问不到再退回脚本。
      asrUrl: '',
      asrPython: '',
      asrScript: '',
      asrModel: 'small',
      asrModelsDir: '',
      asrTorchLib: '',
      asrTimeoutMs: 180_000,
      ttsUrl: '',
      ttsLang: 'zh',
      ttsSpeed: 1,
      ttsTimeoutMs: 120_000,
      refAudio: '',
      refText: '',
      replyTimeoutMs: 180_000,
      // 真的一句话都没答上来时，说一声，别让人对着空气说话
      silentFallback: true,
      // 连着发几条时等一会儿再回：静默这么多毫秒算说完，最长攒这么久
      debounceMs: 1200,
      debounceMaxMs: 4000,
      // 收尾只发寒暄（「晚安」「好呀」）时，干脆少发一条
      trimTail: true,
      maxQueue: 4,
    }
  }

  start() {
    if (this.started) return this
    this.started = true
    this.client.on?.('event', (event) => {
      this.handleEvent(event).catch((error) => {
        this.pushLog('error', String(error?.message ?? error))
      })
    })
    this.client.on?.('status', (status) => {
      const line = status.connected ? `connected #${status.connects}` : status.lastError || 'disconnected'
      // 断线期间每 30 秒都会来一条一样的状态，只记变化，别刷屏
      if (line !== this.lastStatus) {
        this.lastStatus = line
        this.pushLog('status', line)
      }
      if (status.connected) {
        this.#syncSelf().catch((error) => this.pushLog('error', `get_login_info: ${error?.message ?? error}`))
      }
    })
    this.client.connect?.()
    // 自己合成的语音攒着不会自己消失，启动时顺手清一下旧的（只清 say-*.wav）
    try {
      const pruned = pruneVoiceFiles(this.config.voiceDir)
      if (pruned.removed > 0) this.pushLog('debug', `清掉旧语音 ${pruned.removed} 条`)
    } catch (error) {
      this.pushLog('debug', `清旧语音失败：${error?.message ?? error}`)
    }
    this.logger.info?.('[seed-of-memory] QQ 通道已启动')
    return this
  }

  #agentOptions() {
    const options = {}
    const provider = String(this.config.provider ?? '').trim()
    const model = String(this.config.model ?? '').trim()
    const reasoningEffort = String(this.config.reasoningEffort ?? '').trim()
    if (provider) options.provider = provider
    if (model) options.model = model
    if (reasoningEffort) options.reasoningEffort = reasoningEffort
    return Object.keys(options).length > 0 ? options : null
  }

  async #syncSelf() {
    try {
      const info = await this.client.call('get_login_info', {}, 8000)
      if (info?.user_id) this.selfId = String(info.user_id)
      if (info?.nickname) this.nickname = String(info.nickname)
    } catch {
      /* 连接刚建立时可能还没就绪，下一轮事件会补 */
    }
  }

  stop() {
    this.started = false
    try {
      this.client.close?.()
    } catch {
      /* ignore */
    }
    // 还在等静默的几条消息，停的时候别留着定时器。
    for (const buf of this.pending.values()) {
      if (buf?.timer) clearTimeout(buf.timer)
    }
    this.pending.clear()
    for (const record of this.records.values()) {
      try {
        record.dispose?.()
      } catch {
        /* ignore */
      }
    }
    this.records.clear()
    this.waiters.clear()
    try {
      this.history.flush?.()
    } catch {
      /* ignore */
    }
  }

  status() {
    return {
      started: this.started,
      connected: Boolean(this.client?.connected),
      selfId: this.client?.status?.().selfId || this.selfId || '',
      nickname: this.nickname ?? '',
      peers: [...this.records.values()].map((r) => ({
        key: r.key,
        sessionId: r.sessionId,
        busy: r.busy,
        lastActive: r.lastActive,
      })),
      log: this.entries.slice(-MAX_LOG),
      allowPrivate: this.config.allowPrivate ?? [],
      allowGroups: this.config.allowGroups ?? [],
      groupRequireAt: this.config.groupRequireAt !== false,
      autoReply: this.config.autoReply !== false,
      groupPolicy: this.config.groupPolicy ?? 'smart',
      groupTopics: this.config.groupTopics ?? [],
      groupMood: this.getMood?.() ?? null,
      groupStats: [...this.groupStats.entries()].map(([key, value]) => ({ key, ...value })),
      lastInboundAt: this.lastInboundAt,
    }
  }

  /**
   * 主动说话：不经过 agent，直接把一段话发出去（可选语音）。
   * key 形如 `private:10001` / `group:123456`。
   */
  async say(key, text, { voice = false } = {}) {
    const match = /^(private|group):(\d+)$/.exec(String(key ?? '').trim())
    const body = String(text ?? '').trim()
    if (!match || !body) return false
    if (!this.client?.connected) {
      this.pushLog('proactive-skip', '还没连上，先不说了')
      return false
    }
    const scope = match[1]
    const peerId = match[2]
    // 语音是加在文字上面的一层，不是替代品：听不见的时候至少还有字可以读。
    // （原来这里语音一发成功就直接 return，主动消息一带语音就只剩下声音了。）
    let spoke = false
    if (voice && (await this.#canSpeak(body))) {
      spoke = await this.#sendVoice({ scope, peerId, key }, body)
    }
    for (const chunk of chunkText(body)) {
      const params =
        scope === 'group'
          ? { group_id: Number(peerId), message: [{ type: 'text', data: { text: chunk } }] }
          : { user_id: Number(peerId), message: [{ type: 'text', data: { text: chunk } }] }
      const action = scope === 'group' ? 'send_group_msg' : 'send_private_msg'
      try {
        await this.client.call(action, params, 20_000)
        this.pushLog('proactive', `${key} ${chunk.slice(0, 120)}`)
        // 语音发成功时 #sendVoice 里已经记过额度了，这里再记就成了双份。
        if (scope === 'group' && !spoke) this.#noteSpoken(key)
      } catch (error) {
        this.pushLog('proactive-error', `${key} ${String(error?.message ?? error)}`)
        return false
      }
    }
    return true
  }

  pushLog(kind, text) {
    const entry = { at: Date.now(), kind, text: String(text ?? '').slice(0, 300) }
    this.entries.push(entry)
    if (this.entries.length > MAX_LOG * 3) this.entries.splice(0, this.entries.length - MAX_LOG * 3)
    try {
      this.onLog?.(entry)
    } catch {
      /* ignore */
    }
  }

  #allow(ev) {
    const allows = (list, id) => {
      if (!Array.isArray(list) || list.length === 0) return false
      const values = list.map((item) => String(item))
      return values.includes('*') || values.includes(String(id))
    }
    if (ev.message_type === 'private') return allows(this.config.allowPrivate, ev.user_id)
    if (ev.message_type === 'group') return allows(this.config.allowGroups, ev.group_id)
    return false
  }

  /** 这个会话的记忆档位（shared / gui / qq）——路由表给了就用它的。 */
  /** 这个会话在跟谁说话：{ key, scope, peer }，认不出来返回 null。 */
  peerOf(sessionId) {
    return this.peers.get(String(sessionId ?? '')) ?? null
  }

  scopeOf(sessionId) {
    return this.scopes.get(String(sessionId ?? '')) ?? null
  }

  /**
   * 这条消息走哪条路由。没配 routes 就退回老白名单（allowPrivate / allowGroups），
   * 配了就交给 routes.js 的 routeOf —— 群聊「接不接」之后仍由 #admitGroup 决定「回不回」。
   */
  #route(ev) {
    const fallback = ({ allow, reason }) => ({
      allow,
      key: '',
      routeId: '',
      cwd: '',
      memoryScope: 'qq',
      gated: false,
      reason,
    })
    if (!Array.isArray(this.config.routes)) {
      return this.#allow(ev) ? fallback({ allow: true, reason: '白名单' }) : fallback({ allow: false, reason: '不在白名单里' })
    }
    let out
    try {
      out = routeOf(ev, this.config, { now: Date.now(), orders: this.orders })
    } catch (error) {
      this.pushLog('debug', `路由判定出岔子，按白名单来：${error?.message ?? error}`)
      return this.#allow(ev) ? fallback({ allow: true, reason: '白名单' }) : fallback({ allow: false, reason: '不在白名单里' })
    }
    for (const warning of out.warnings ?? []) {
      if (this.routeWarned.has(warning)) continue
      this.routeWarned.add(warning)
      this.pushLog('debug', `routes 配置：${warning}`)
    }
    return out
  }

  /** 「放她进来」这类指令：记一条 order，gateRules 下次就放行。 */
  #recordOrder(ev, text, route) {
    if (!isOrder(text, this.config.orderTriggers)) return false
    const from = String(ev?.sender?.user_id ?? ev?.user_id ?? '')
    if (!from) return false
    this.orders.push({ from, routeId: String(route?.routeId ?? ''), at: Date.now(), text: String(text).slice(0, 40) })
    if (this.orders.length > 50) this.orders.splice(0, this.orders.length - 50)
    this.pushLog('debug', `记下一条指令（${from} → ${route?.routeId || '默认'}）`)
    return true
  }

  /**
   * 群消息要不要接：@我、回我、提到我名字、命中兴趣词，或心情好到想随口说一句。
   * 返回 false 表示这条不理（潜水）。
   */
  #admitGroup(ev, segments, text) {
    const key = `group:${ev.group_id}`
    const policy = String(this.config.groupPolicy ?? 'smart')
    const mentioned = mentionedSelf(segments, ev.self_id)

    if (policy === 'at') {
      if (this.config.groupRequireAt !== false && !mentioned) {
        this.pushLog('lurk', `${key} 没 @ 我`)
        return false
      }
      return true
    }

    const stats = this.groupStats.get(key) ?? {}
    const decision = decideGroupReply({
      text,
      mentioned,
      repliedToMe: this.#repliedToMe(segments),
      mood: this.getMood?.() ?? {},
      config: this.config,
      now: Date.now(),
      lastSpokeAt: stats.lastSpokeAt ?? 0,
      hourCount: stats.hourCount ?? 0,
      dayCount: stats.dayCount ?? 0,
    })
    if (!decision.reply) {
      this.pushLog('lurk', `${key} ${decision.reason}${text ? ` · ${text.slice(0, 80)}` : ''}`)
      return false
    }
    this.pushLog(
      'join',
      `${key} ${decision.reason} · 电量 ${decision.energy.toFixed(2)} · 兴趣 ${Math.round(decision.interest * 100)}%`,
    )
    return true
  }

  #repliedToMe(segments) {
    if (this.myMessageIds.size === 0) return false
    for (const seg of segments) {
      if (seg?.type !== 'reply') continue
      const id = seg?.data?.id ?? seg?.data?.message_id
      if (id && this.myMessageIds.has(String(id))) return true
    }
    return false
  }

  #noteSpoken(key) {
    if (!key?.startsWith('group:')) return
    this.groupStats.set(key, bumpGroupStats(this.groupStats.get(key) ?? {}, Date.now()))
  }

  #noteSent(scope, res) {
    const id = res?.message_id ?? res?.data?.message_id
    if (!id) return
    this.myMessageIds.add(String(id))
    if (this.myMessageIds.size > 300) this.myMessageIds.delete(this.myMessageIds.values().next().value)
  }

  async handleEvent(ev) {
    // 诊断：查「语音到底有没有到」。只在不常见的形状上记一行（语音段 / 非 message 事件），
    // 平时的文字消息不会多出日志。真到了却认不出来时，这行就是唯一的证据。
    try {
      const segs = Array.isArray(ev?.message) ? ev.message : []
      const kinds = segs.map((seg) => String(seg?.type ?? '?'))
      // notice（好友上下线、群成员变动）和 meta_event（心跳）太吵，不算「不常见的形状」。
      const quiet = ev?.post_type === 'meta_event' || ev?.post_type === 'notice'
      const notable =
        (!quiet && ev?.post_type !== 'message') ||
        kinds.some((k) => /record|ptt|voice|audio/i.test(k))
      if (notable) {
        const shape = kinds.length ? `[${kinds.join(',')}]` : `(${typeof ev?.message})`
        const raw = String(ev?.raw_message ?? '').slice(0, 60)
        this.pushLog('raw', `${ev?.post_type ?? '?'}/${ev?.message_type ?? '?'} id=${ev?.message_id ?? '-'} segs=${shape} raw=${raw}`)
      }
    } catch {
      /* 记不下来不影响正事 */
    }
    if (!ev || ev.post_type !== 'message') return
    if (String(ev.user_id ?? '') === String(ev.self_id ?? '')) return
    if (ev.message_id && this.seen.has(String(ev.message_id))) return
    if (ev.message_id) {
      this.seen.add(String(ev.message_id))
      if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value)
    }

    const isGroup = ev.message_type === 'group'
    const key = isGroup ? `group:${ev.group_id}` : `private:${ev.user_id}`
    const route = this.#route(ev)
    if (!route.allow) {
      const raw = String(ev.raw_message ?? '').slice(0, 80)
      this.pushLog(route.gated ? 'lurk' : 'deny', route.gated ? `${key} ${route.reason}` : `${key} ${route.reason} · ${raw}`)
      return
    }
    this.lastInboundAt = Date.now()
    if (this.config.autoReply === false) {
      // 只听不回：群里别人闲聊不算「他说话了」，只认私聊和 @ 我
      const atMe = segmentsOf(ev.message).some(
        (seg) => seg.type === 'at' && String(seg.data?.qq ?? '') === String(ev.self_id ?? '')
      )
      if (isGroup && !atMe) this.lastInboundAt = this.lastInboundAtBefore ?? 0
      this.lastInboundAtBefore = this.lastInboundAt
      this.pushLog('observe', `${key} 只听不回`)
      return
    }

    const segments = segmentsOf(ev.message)

    const records = this.config.voiceIn === false ? [] : recordSegments(segments)
    let text = textOf(segments)
    let unhearable = false
    let asrFailed = false

    // 图片：落一张到本地，把路径写进消息里。
    // 模型看到 `[图片] D:\...\xxx.jpg` 就会自己去读——比自己转成 base64 塞进上下文省事得多。
    const images = this.config.imageIn === false ? [] : imageSegments(segments)
    if (images.length > 0) {
      const voiceDir = String(this.config.voiceDir ?? '').trim()
      const imageDir =
        String(this.config.imageDir ?? '').trim() || (voiceDir ? join(voiceDir, 'images') : '')
      if (!imageDir) {
        this.pushLog('image-skip', `${key} 没配 imageDir，图片收不下来`)
      } else {
        const kept = []
        for (const seg of images.slice(0, 3)) {
          const path = await resolveImageFile({ client: this.client, seg, dir: imageDir, logger: this.logger })
          if (path) kept.push(path)
        }
        if (kept.length > 0) {
          const lines = kept.map((path) => `[图片] ${path}`).join('\n')
          this.pushLog('image-in', `${key} ${kept.length} 张`)
          text = text ? `${text}\n${lines}` : lines
        } else {
          this.pushLog('image-skip', `${key} 图片没落下来`)
          if (!text) text = '（发来一张图，我这边没收下来——你再发一次，或者告诉我图上是什么）'
        }
      }
    }

    if (records.length > 0) {
      const caps = await this.#voiceStatus()
      if (caps.asr.ok) {
        const heard = await this.#transcribeRecords(key, records)
        if (heard.text) text = text ? `${heard.text}\n${text}` : heard.text
        else if (heard.failed) asrFailed = true
      } else {
        unhearable = true
        this.pushLog('voice-skip', `${key} 没装语音识别：${caps.asr.reason}`)
      }
    }
    this.#recordOrder(ev, text, route)

    if (!text) {
      const fallback = voiceFallback({ text, unhearable, asrFailed })
      if (fallback === 'unavailable') await this.#noticeVoiceUnavailable(key, ev)
      else if (fallback === 'hear-failed') await this.#noticeHearFailed(key, ev)
      this.pushLog('skip', `${key} 只有非文字内容`)
      return
    }

    if (isGroup && !this.#admitGroup(ev, segments, text)) return

    // 网关/宿主自己的报错有时会被当成「有人发了一条消息」递进来。
    // 那不是他说的话，回它只会把一串 RemoteError 再念一遍。
    // 但判据不能只看关键词，否则人问一句「RemoteError 是什么梗」也会被吞。
    if (looksLikeInternalError(text)) {
      this.pushLog('skip', `${key} 内部报错被当成消息了`)
      return
    }

    this.pushLog('in', `${key} ${text.slice(0, 200)}`)
    // 他这条回来了：没落定的问句标成「已回话」，等模型判断怎么收。
    if (this.onReplied) {
      try {
        this.onReplied(key, text)
      } catch {
        /* 账本出错不影响回话 */
      }
    }

    const reset = /^\/reset\b/i.test(text)
    // 连着发好几条的时候，别一条一轮地抢答：等一小会儿静默，合成一轮再回。
    if (!reset && !isGroup && this.#debounceMs() > 0) {
      this.#queueText(key, isGroup, ev, route, text)
      return
    }
    if (reset) await this.#flushPending(key)
    await this.#dispatch(key, isGroup, ev, route, text, { reset })
  }

  #debounceMs() {
    const wait = Number(this.config.debounceMs)
    return Number.isFinite(wait) && wait > 0 ? wait : 0
  }

  #queueText(key, isGroup, ev, route, text) {
    const now = Date.now()
    const wait = this.#debounceMs()
    const spanRaw = Number(this.config.debounceMaxMs)
    const span = Math.max(wait, Number.isFinite(spanRaw) && spanRaw > 0 ? spanRaw : 4000)
    let buf = this.pending.get(key)
    if (!buf) {
      buf = { texts: [], at: now, timer: null, isGroup, ev, route }
      this.pending.set(key, buf)
    }
    buf.texts.push(text)
    buf.ev = ev
    buf.route = route
    if (buf.timer) clearTimeout(buf.timer)
    const delay = Math.max(0, Math.min(wait, buf.at + span - now))
    buf.timer = setTimeout(() => {
      void this.#flushPending(key)
    }, delay)
    if (typeof buf.timer?.unref === 'function') buf.timer.unref()
  }

  async #flushPending(key) {
    const buf = this.pending.get(key)
    if (!buf) return
    this.pending.delete(key)
    if (buf.timer) clearTimeout(buf.timer)
    const text = buf.texts.map((part) => String(part ?? '').trim()).filter(Boolean).join('\n')
    if (!text) return
    try {
      await this.#dispatch(key, buf.isGroup, buf.ev, buf.route, text, { merged: buf.texts.length })
    } catch (error) {
      this.pushLog('error', `${key} ${String(error?.message ?? error)}`)
    }
  }

  async #dispatch(key, isGroup, ev, route, text, { reset = false, merged = 1 } = {}) {
    if (merged > 1) this.pushLog('debug', `${key} 合成一轮（${merged} 条）`)
    const record = await this.#ensure(key, isGroup, ev, route)
    if (!record) return
    // 他明说要一条语音：这一轮回完补一句，不按「每隔几条」的节奏等
    if (wantsVoice(text)) record.forceVoice = true

    if (reset) {
      await this.#reset(record)
      await this.#send(record, '好，重新开始。')
      return
    }

    const queueDepth = record.queueDepth ?? 0
    if (queueDepth >= Number(this.config.maxQueue || 4)) {
      this.pushLog('busy', `${key} 排队 ${queueDepth}`)
    }
    record.queueDepth = queueDepth + 1
    record.chain = (record.chain ?? Promise.resolve())
      .then(() => this.#turn(record, text))
      .catch((error) => this.pushLog('error', `${key} ${String(error?.message ?? error)}`))
      .finally(() => {
        record.queueDepth = Math.max(0, (record.queueDepth ?? 1) - 1)
        record.lastActive = Date.now()
      })
    await record.chain.catch(() => {})
  }

  async #ensure(key, isGroup, ev, route = null) {
    const hit = this.records.get(key)
    if (hit) return hit
    const inflight = this.ensuring.get(key)
    if (inflight) {
      try {
        return await inflight
      } catch {
        return null
      }
    }
    const job = this.#openRecord(key, isGroup, ev, route)
    this.ensuring.set(key, job)
    try {
      return await job
    } finally {
      this.ensuring.delete(key)
    }
  }

  async #openRecord(key, isGroup, ev, route = null) {
    // 一条路由一个会话：同一个人的私聊落到不同工作区时，别共用一份历史。
    const mapKey = route?.routeId ? `${key}@${route.routeId}` : key
    const baseId = `seedqq-${sha1(mapKey).slice(0, 16)}`
    const cwd = String(route?.cwd ?? '').trim() || String(this.config.cwd ?? '').trim() || undefined
    // 这个 key 上次换过 id（坏记录 / cwd 变了 / /reset）就沿用记下来的那个，
    // 否则每次重启都会重开一份新会话。
    let sessionId = baseId
    try {
      const mapped = this.history?.sessionOf?.(mapKey) ?? ''
      if (mapped) sessionId = mapped
    } catch {
      /* ignore */
    }
    const rotate = this.rotateNext.delete(key)
    let needsFresh = rotate
    let agent = null
    let dispose = null
    let owned = false

    try {
      const live = this.agents.get?.(sessionId)
      if (live && typeof live.followup === 'function') {
        agent = live
      }
    } catch {
      /* ignore */
    }

    if (!agent && !rotate) {
      try {
        const handle = await this.agents.resume({
          resumeSessionId: sessionId,
          ...(this.#agentOptions() ? { agentOptions: this.#agentOptions() } : {}),
        })
        if (handle?.agent) {
          agent = handle.agent
          dispose = handle.dispose
          owned = true
        }
      } catch (error) {
        // 插件建的会话宿主不会落盘，所以这里基本必然未命中；每个 key 只说一次
        if (!this.resumeMissed.has(key)) {
          this.resumeMissed.add(key)
          this.pushLog('debug', `resume ${sessionId.slice(0, 8)} 未命中（本地历史接管）：${error?.message ?? error}`)
        }
      }
    }

    // 宿主里那份旧会话是用别的 cwd 建的（比如以前配的是 E:\cz，现在是 D:\work）。
    // 工作区不允许跨目录，continue 下去它永远进不了新工作区，所以换一份新的。
    const resumedCwd = String(agent?.header?.cwd ?? '').trim()
    if (agent && cwd && resumedCwd && !samePath(resumedCwd, cwd)) {
      this.pushLog('debug', `会话 ${sessionId.slice(0, 8)} 的 cwd 是 ${resumedCwd}，换成 ${cwd} 重新开一份`)
      try {
        await dispose?.()
      } catch {
        /* ignore */
      }
      agent = null
      dispose = null
      owned = false
      needsFresh = true
    }

    let usedId = sessionId
    if (!agent) {
      // 旧记录坏了的时候，resume 和「用同一个 id create」都会炸（create 会先恢复同名记录）。
      // 所以第二轮试一个新 id：旧记录留在盘上不动，也不删任何用户数据。
      const freshId = `${sessionId}-r${Date.now().toString(36).slice(-6)}`
      const attempts = needsFresh || this.brokenSessions.has(sessionId) ? [freshId] : [sessionId, freshId]
      let lastError = null
      for (const tryId of attempts) {
        try {
          const handle = await this.agents.create({
            sessionId: tryId,
            ...(cwd ? { meta: { cwd } } : {}),
            ...(this.#agentOptions() ? { agentOptions: this.#agentOptions() } : {}),
          })
          if (!handle?.agent) throw new Error('agents.create 没有返回 agent')
          agent = handle.agent
          dispose = handle.dispose
          owned = true
          usedId = tryId
          this.freshSessions.add(tryId)
          if (tryId !== sessionId) {
            this.brokenSessions.add(sessionId)
            try {
              this.history?.markBroken?.(sessionId)
            } catch {
              /* ignore */
            }
          }
          try {
            this.history?.mapSession?.(mapKey, tryId)
          } catch {
            /* ignore */
          }
          lastError = null
          break
        } catch (error) {
          lastError = error
        }
      }
      if (lastError) {
        this.pushLog('error', `创建会话失败 ${key}：${lastError?.message ?? lastError}`)
        return null
      }
    }

    // 让这个会话出现在某个工作区里，而不是掉进侧栏的「未分组」。
    // 工作区要求「会话 header 的 cwd 和工作区路径完全一致」，而且它读的是**已经落盘**的
    // header——刚 create 完那会儿还没写盘，只试一次等于白试，所以放到后台多试几次。
    const ownCwd = String(agent?.header?.cwd ?? cwd ?? '').trim()
    if (ownCwd) void this.#attachSoon(usedId, ownCwd)

    // 语音节奏跟着会话走：重启、改设置重建通道时不要从零数，
    // 否则「隔着发」永远只在前三条里原地打转。
    let pastTurns = 0
    try {
      pastTurns = this.history?.get?.(key, 100)?.length ?? 0
    } catch {
      pastTurns = 0
    }

    const record = {
      key,
      sessionId: usedId,
      scope: isGroup ? 'group' : 'private',
      peerId: isGroup ? ev.group_id : ev.user_id,
      agent,
      dispose: owned ? dispose : null,
      chain: Promise.resolve(),
      queueDepth: 0,
      turns: pastTurns,
      memoryScope: normalizeScope(route?.memoryScope ?? 'qq'),
      mapKey,
      lastActive: Date.now(),
    }
    this.records.set(key, record)
    this.scopes.set(usedId, record.memoryScope)
    try {
      this.peers.set(usedId, { key, scope: record.scope, peer: record.peerId })
    } catch {
      /* 记不住就算了，卡片少一行 */
    }
    this.pushLog('ready', `${key} → ${usedId}`)
    return record
  }

  /**
   * 把会话挂进工作区。宿主读的是已经落盘的 header，刚 create 完那会儿还没有，
   * 所以隔一会儿再试，最多六次（约三秒）；挂上了只记一行 debug，方便对账。
   */
  async #attachSoon(sessionId, cwd) {
    if (!this.attachWorkspace) return
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        const done = await this.attachWorkspace(sessionId, cwd)
        if (done) {
          this.pushLog('debug', `挂进工作区：${cwd}`)
          return
        }
      } catch (error) {
        this.pushLog('debug', `挂进工作区没成（第 ${attempt} 次）：${error?.message ?? error}`)
      }
      await sleep(500)
    }
    this.pushLog('debug', `挂进工作区没成：${cwd}（试了 6 次）`)
  }

  async #reset(record) {
    try {
      await record.dispose?.()
    } catch {
      /* ignore */
    }
    this.records.delete(record.key)
    this.freshSessions.delete(record.sessionId)
    // 说「重新开始」就该真的重开：下一句换成新会话，而不是把旧会话恢复回来。
    this.rotateNext.add(record.key)
    try {
      this.history.clear(record.mapKey ?? record.key)
    } catch {
      /* ignore */
    }
    this.pushLog('reset', record.key)
  }

  /** 宿主把每个 session 事件都送进来，这里只认「助手说完一整条」的那一刻。 */
  onSessionEvent(session, event) {
    const sessionId =
      session?.header?.id ??
      session?.id ??
      event?.sessionId ??
      event?.session?.id ??
      event?.session?.header?.id
    if (!sessionId) return
    const type = event?.type ?? event?.data?.type ?? ''
    if (type !== 'assistant/message' && type !== 'turn/end') return
    const waiter = this.waiters.get(String(sessionId))
    if (!waiter) return
    const text = textOfMessage(event?.data?.message ?? event?.message)
    if (text) waiter.text = text
    if (type === 'assistant/message' && text) waiter.resolve(text)
    else if (type === 'turn/end') {
      const reason = event?.data?.reason
      if (!waiter.text && reason?.kind === 'error') {
        this.pushLog('error', `turn 失败：${reason.error?.message ?? 'unknown'}`)
      }
      waiter.resolve(waiter.text ?? '')
    }
  }

  #waitReply(sessionId, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // 先取再删——反过来的话已经收到的半截回复会被自己删掉，白等一场。
        const waiter = this.waiters.get(String(sessionId))
        this.waiters.delete(String(sessionId))
        resolve(waiter?.text ?? '')
      }, Math.max(15_000, Number(timeoutMs) || 180_000))
      timer.unref?.()
      this.waiters.set(String(sessionId), {
        text: '',
        resolve: (text) => {
          clearTimeout(timer)
          this.waiters.delete(String(sessionId))
          resolve(text)
        },
      })
    })
  }

  /**
   * 把 `[图片] 路径` 那几行变成真正的 image block。
   *
   * QQ 会话的工具是精简过的（只有 64 个，没有 read_image），
   * 光给路径它读不了 —— 它会直说「图我这边没打开」。
   * 所以这里把图交给宿主的 attachment store（内容寻址），
   * 再以 image block 塞进消息里，模型就真的看得见了。
   */
  async #imageBlocksFor(text) {
    const blocks = []
    const store = this.attachments
    if (!store || typeof store.saveImage !== 'function') return blocks
    const re = /^\[图片\]\s*(.+)$/gm
    let match
    while ((match = re.exec(String(text ?? ''))) !== null) {
      const path = match[1].trim()
      try {
        const data = readFileSync(path)
        const mediaType = /\.png$/i.test(path)
          ? 'image/png'
          : /\.webp$/i.test(path)
            ? 'image/webp'
            : /\.gif$/i.test(path)
              ? 'image/gif'
              : /\.bmp$/i.test(path)
                ? 'image/bmp'
                : 'image/jpeg'
        const ref = await store.saveImage({ data, mediaType, name: basename(path) })
        if (ref) blocks.push({ type: 'image', attachment: ref })
      } catch (error) {
        // 塞不进上下文也别让整轮哑掉：正文里还有那行路径，至少能说「没收下来」。
        this.pushLog('image-skip', `${path} 塞不进上下文：${error?.message ?? error}`)
      }
    }
    return blocks
  }

  async #turn(record, text) {
    record.turns = (record.turns ?? 0) + 1
    const factory = await userMessageFactory()
    // 重启后的新会话：先把本地存下的最近几句带上（只带一次）
    let body = text
    let recap = ''
    try {
      recap = this.freshRecap(record.sessionId)
    } catch {
      recap = ''
    }
    if (recap) body = `${recap}\n\n（下面是老大刚发来的）\n${text}`
    // 记忆卡只在会话开头注入一次，后面几轮模型就看不见「[场景]」了，
    // 会以为自己在 GUI 里，于是不写语音那行。这条每轮都跟着消息走。
    // 会话里的上下文是混着的，光看正文分不清「这是谁在说话」——
    // 别人私聊进来时会以为还是老大，张口就叫「老大」。
    const peer = String(record.peerId ?? '')
    const owner = String(this.config.ownerQQ ?? '').trim()
    const fromLine =
      record.scope === 'group'
        ? `\n\n[这条来自群 ${peer}]`
        : owner && peer === owner
          ? ''
          : `\n\n[这条来自 QQ ${peer}，不是老大本人：别叫他老大，也别把你们之间的事讲给他听。]`
    body = `${body}${fromLine}${QQ_TURN_NOTE}`
    const imageBlocks = await this.#imageBlocksFor(text)
    const content = [{ type: 'text', text: body }, ...imageBlocks]
    const message = factory({ content, source: { kind: 'user' } })
    const wait = this.#waitReply(record.sessionId, this.config.replyTimeoutMs)
    this.pushLog('turn', `${record.key} ${text.slice(0, 80)}`)
    await Promise.resolve(record.agent.followup?.(message))
    let reply = await wait
    if (record.agent.whenIdle) {
      try {
        const idleWait = new Promise((resolve) => {
          const timer = setTimeout(resolve, 20_000)
          timer.unref?.()
        })
        await Promise.race([Promise.resolve(record.agent.whenIdle()), idleWait])
      } catch {
        /* ignore */
      }
    }
    reply = String(reply ?? '').trim()
    // 宿主内部出错时，那一轮的回答可能就是一串报错（「RemoteError: … never started」）。
    // 这种字面别发到聊天里——换成一句人话，细节留给日志。
    if (looksLikeInternalError(reply)) {
      this.pushLog('debug', `回复里带了内部错误，换成人话：${reply.slice(0, 80)}`)
      reply = '刚才那边卡了一下，没接上——你再说一遍？'
    }
    if (!reply) {
      this.pushLog('silent', record.key)
      if (this.config.silentFallback !== false) {
        try {
          await this.#send(record, '刚才卡了一下，没说出话——你再说一遍？')
        } catch {
          /* 说不出去也没办法 */
        }
      }
      return
    }
    try {
      // 账本里存正文就行：`[语音]…` 那行是给耳朵的，留着它，下次重启做「刚才」
      // 复盘时会把它当成说过的话再播一遍。
      const spoken = splitVoiceNote(reply).body || reply
      this.history.append(record.key, { u: text, a: spoken })
    } catch {
      /* 账本坏了也不能影响回话 */
    }
    await this.#send(record, reply)
  }

  async #transcribeRecords(key, records) {
    const voiceDir = String(this.config.voiceDir ?? '').trim()
    if (!voiceDir) return { text: '', failed: false }
    const lines = []
    let failed = false
    for (const seg of records.slice(0, 2)) {
      const path = await resolveRecordFile({
        client: this.client,
        seg,
        dir: voiceDir,
        logger: this.logger,
      })
      if (!path) {
        this.pushLog('voice-skip', `${key} 语音文件拿不到`)
        failed = true
        continue
      }
      const result = await transcribeFile(this.config, path)
      this.pushLog('debug', `${key} 转写走${result.via === 'service' ? '常驻服务' : '本地脚本'}，服务地址=[${this.config.asrUrl ?? ''}]`)
      if (!result.ok) {
        this.pushLog('voice-error', `${key} ASR：${result.error}`)
        failed = true
        continue
      }
      this.pushLog('voice-in', `${key} ${result.text.slice(0, 120)}（${result.via === 'service' ? '常驻' : '脚本'} ${Math.round((result.ms ?? 0) / 100) / 10}s${result.note ? '｜' + result.note : ''}）`)
      lines.push(`（语音）${result.text}`)
    }
    return { text: lines.join('\n'), failed }
  }

  async #send(record, text) {
    // 文字先发：语音是加在上面的一层，不是替代。
    // 听不见、不想听、客户端不支持的时候，至少还有字可以读。
    // 正文里另起一行写的 `[语音]…` 只念出来，不跟着正文发。
    const { body: said, say } = splitVoiceNote(text)
    // 诊断：模型到底有没有写那一行？语音是照着它念，还是退回去念正文？
    if (say) this.pushLog('debug', `${record.key} 语音行 ${say.length} 字：${say.slice(0, 30)}`)
    else this.pushLog('debug', `${record.key} 没写语音行，退回念正文`)
    const body = this.config.trimTail === false ? said : trimTailText(said)
    let bubbles =
      this.config.burst === false
        ? chunkText(body)
        : splitBubbles(body, Math.min(4, Math.max(1, Number(this.config.burstMax) || 3)))
    // 收尾沉默：最后一条只是「晚安」「好呀」这种寒暄时，少发一条。
    if (this.config.trimTail !== false && bubbles.length > 1) bubbles = trimTailBubbles(bubbles)
    const gap = Math.max(0, Number(this.config.burstGapMs) || 0)
    for (let i = 0; i < bubbles.length; i++) {
      const chunk = bubbles[i]
      if (i > 0 && gap) await sleep(gap * (0.7 + Math.random() * 0.6))
      const params =
        record.scope === 'group'
          ? { group_id: Number(record.peerId), message: [{ type: 'text', data: { text: chunk } }] }
          : { user_id: Number(record.peerId), message: [{ type: 'text', data: { text: chunk } }] }
      const action = record.scope === 'group' ? 'send_group_msg' : 'send_private_msg'
      try {
        const res = await this.client.call(action, params, 20_000)
        this.#noteSent(record.scope, res)
        this.pushLog('out', `${record.key} ${chunk.slice(0, 120)}`)
      } catch (error) {
        const message = String(error?.message ?? error)
        // 超时 = 不知道对方收没收到。标成「结果未知」，不重发——
        // 重发很可能让人看到同一句话两遍。
        const unknown = /timeout|timed out|超时/i.test(message)
        this.pushLog(unknown ? 'send-unknown' : 'send-error', `${record.key} ${message}`)
      }
    }
    // 字说完了，再看要不要补一条语音（默认每 3 次回一条）。
    // 写了 `[语音]…` 就念那句，不看节奏——那是明确想让它出声的。
    const spoke = say ? await this.#canSpeakNote(say) : await this.#shouldSpeak(record, body)
    if (spoke) {
      await this.#sendVoice(record, say || body)
    } else {
      // 群里的额度（每小时/每天说几句）一次回复只该记一次：
      // 发了语音的话，#sendVoice 里已经记过，这里再记就成了双份。
      this.#noteSpoken(record.key)
    }
    // 话里要等回音的那句，记成「未完话头」。
    if (this.onAsked) {
      try {
        this.onAsked(record, body)
      } catch {
        /* 记不住就算了，别影响才发出去的话 */
      }
    }
  }

  async #voiceStatus(force = false) {
    return this.voiceProbe.get(this.config, { force })
  }

  /** TTS 不在的时候每 10 分钟提醒一次（不然日志里刷屏）。 */
  #warnTts(reason) {
    const now = Date.now()
    if (now - this.ttsWarnAt <= 10 * 60_000) return
    this.ttsWarnAt = now
    this.pushLog('tts-skip', `这次只有文字：${reason}`)
  }

  /**
   * 探活只等两秒：TTS 正在合成上一句的时候，这个探测会误报「连不上」。
   * 所以最近十分钟真发出去过，就认为它还活着，让这次真发一遍试试；
   * 真挂了的话，发的时候会失败、日志里写 `voice-error`，不再只是猜。
   */
  #ttsMaybeUp(caps) {
    if (caps?.tts?.ok) return true
    if (Date.now() - this.ttsHealthyAt <= 10 * 60_000) return true
    this.#warnTts(caps?.tts?.reason ?? 'tts 不可用')
    return false
  }

  /**
   * 正文里点名的 `[语音]…`：只要 TTS 在就念，不看节奏、不按 voiceMaxChars 卡。
   * 但仍然拦两种念出来没意义的东西：代码块和链接；太长也不念（一次说不完）。
   */
  async #canSpeakNote(text) {
    const value = String(text ?? '').trim()
    if (!value) return false
    if (value.length > 200) {
      this.pushLog('tts-skip', `[语音] 那段太长（${value.length} 字），这次不念`)
      return false
    }
    if (/```|https?:\/\//i.test(value)) {
      this.pushLog('tts-skip', '[语音] 那段里有代码或链接，这次不念')
      return false
    }
    const mode = String(this.config.voiceOut ?? 'auto').toLowerCase()
    if (mode === 'off' || mode === 'false') return false
    const caps = await this.#voiceStatus()
    if (!this.#ttsMaybeUp(caps)) return false
    return true
  }

  /** 现在能不能说：配置允许、这句话适合说、并且 TTS 真的在。（主动消息的 say 用） */
  async #canSpeak(text) {
    const mode = String(this.config.voiceOut ?? 'auto').toLowerCase()
    if (mode === 'off' || mode === 'false') return false
    if (mode !== 'always' && !looksSpeakable(text, this.config.voiceMaxChars)) return false
    const caps = await this.#voiceStatus()
    if (!this.#ttsMaybeUp(caps)) return false
    return true
  }

  /** 回复里要不要再补一条语音：文字已经发过了，这里只管节奏。 */
  async #shouldSpeak(record, text) {
    const forced = record.forceVoice === true
    record.forceVoice = false
    const mode = String(this.config.voiceOut ?? 'auto').toLowerCase()
    if (mode === 'off' || mode === 'false') return false
    if (!forced && !voiceCadence({ mode, turns: record.turns, every: this.config.voiceEvery })) {
      return false
    }
    const maxChars = forced
      ? Math.max(Number(this.config.voiceMaxChars) || 80, 160)
      : this.config.voiceMaxChars
    if (!looksSpeakable(text, maxChars)) return false
    const caps = await this.#voiceStatus()
    if (!this.#ttsMaybeUp(caps)) return false
    return true
  }

  /** 收到语音但本机听不到时，温和地说明一次（同一个会话 15 分钟内只说一次）。 */
  async #noticeVoiceUnavailable(key, ev) {
    const now = Date.now()
    const last = Number(this.voiceNotices.get(key) ?? 0)
    if (now - last < 15 * 60_000) return
    this.voiceNotices.set(key, now)
    if (this.voiceNotices.size > 100) this.voiceNotices.delete(this.voiceNotices.values().next().value)
    try {
      const message = [{ type: 'text', data: { text: VOICE_NOTICE } }]
      const params =
        ev.message_type === 'group'
          ? { group_id: Number(ev.group_id), message }
          : { user_id: Number(ev.user_id), message }
      const action = ev.message_type === 'group' ? 'send_group_msg' : 'send_private_msg'
      await this.client.call(action, params, 15_000)
      this.pushLog('voice-notice', key)
    } catch (error) {
      this.pushLog('voice-error', `${key} 提示发送失败：${String(error?.message ?? error)}`)
    }
  }

  /** 语音转文字失败时说明一次，别让人对着空气说话（同一个会话 10 分钟内只说一次）。 */
  async #noticeHearFailed(key, ev) {
    const now = Date.now()
    const last = Number(this.voiceNotices.get(key) ?? 0)
    if (now - last < 10 * 60_000) return
    this.voiceNotices.set(key, now)
    if (this.voiceNotices.size > 100) this.voiceNotices.delete(this.voiceNotices.values().next().value)
    try {
      const message = [{ type: 'text', data: { text: '刚才那条语音我没转成文字，再说一遍或者打字都行。' } }]
      const params =
        ev.message_type === 'group'
          ? { group_id: Number(ev.group_id), message }
          : { user_id: Number(ev.user_id), message }
      const action = ev.message_type === 'group' ? 'send_group_msg' : 'send_private_msg'
      await this.client.call(action, params, 15_000)
      this.pushLog('voice-notice', `${key} 没听清`)
    } catch (error) {
      this.pushLog('voice-error', `${key} 提示发送失败：${String(error?.message ?? error)}`)
    }
  }

  async #sendVoice(record, text) {
    const voiceDir = String(this.config.voiceDir ?? '').trim()
    if (!voiceDir) return false
    const result = await synthesizeToFile({ ...this.config, voiceDir }, text)
    if (!result.ok) {
      this.pushLog('voice-error', `${record.key} ${result.error}`)
      return false
    }
    const file = voiceFileName(result.path)
    const payload = [{ type: 'record', data: { file: result.path.replace(/\\/g, '/') } }]
    const params =
      record.scope === 'group' ? { group_id: Number(record.peerId), message: payload } : { user_id: Number(record.peerId), message: payload }
    const action = record.scope === 'group' ? 'send_group_msg' : 'send_private_msg'
    try {
      const res = await this.client.call(action, params, 30_000)
      this.#noteSent(record.scope, res)
      this.#noteSpoken(record.key)
      this.ttsHealthyAt = Date.now()
      this.pushLog('voice', `${record.key} ${file} ${audioSize(result.path)}B`)
      return true
    } catch (error) {
      this.pushLog('voice-error', `${record.key} ${String(error?.message ?? error)}`)
      return false
    }
  }
}
