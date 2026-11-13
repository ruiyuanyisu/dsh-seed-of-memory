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
import { segmentsOf, textOf, mentionedSelf, userMessageFactory } from './message.js'
import { decideGroupReply, bumpGroupStats, GROUP_DEFAULTS } from './group.js'
import { VoiceProbe, VOICE_NOTICE } from '../voice.js'
import {
  recordSegments,
  resolveRecordFile,
  transcribeFile,
  synthesizeToFile,
  looksSpeakable,
  voiceFileName,
  audioSize,
} from './media.js'

const MAX_LOG = 30
const SEEN_LIMIT = 400
const MAX_REPLY_CHARS = 1200

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
export function splitBubbles(text, max = 3, size = 90) {
  const raw = String(text ?? '').trim()
  if (!raw) return []
  if (max <= 1) return [raw]
  const pieces = raw
    .split(/(?<=[。！？!?…～~；;\n])/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (pieces.length <= 1) return [raw]
  const groups = []
  let cur = ''
  for (const piece of pieces) {
    if (!cur) cur = piece
    else if (cur.length + piece.length <= size) cur += piece
    else {
      groups.push(cur)
      cur = piece
    }
  }
  if (cur) groups.push(cur)
  if (groups.length <= max) return groups
  return [...groups.slice(0, max - 1), groups.slice(max - 1).join('')]
}

function sleep(ms) {
  return new Promise((resolve) => {
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
  constructor({ client, agents, config = {}, logger = console, onLog = null, getMood = null }) {
    this.client = client
    this.agents = agents
    this.config = config
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
    this.voiceNotices = new Map()
    this.ttsWarnAt = 0
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
      voiceDir: '',
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
      this.pushLog('status', status.connected ? `connected #${status.connects}` : status.lastError || 'disconnected')
      if (status.connected) {
        this.#syncSelf().catch((error) => this.pushLog('error', `get_login_info: ${error?.message ?? error}`))
      }
    })
    this.client.connect?.()
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
    for (const record of this.records.values()) {
      try {
        record.dispose?.()
      } catch {
        /* ignore */
      }
    }
    this.records.clear()
    this.waiters.clear()
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
    if (voice && (await this.#canSpeak(body))) {
      const spoken = await this.#sendVoice({ scope, peerId, key }, body)
      if (spoken) return true
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
        if (scope === 'group') this.#noteSpoken(key)
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
    if (!ev || ev.post_type !== 'message') return
    if (String(ev.user_id ?? '') === String(ev.self_id ?? '')) return
    if (ev.message_id && this.seen.has(String(ev.message_id))) return
    if (ev.message_id) {
      this.seen.add(String(ev.message_id))
      if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value)
    }

    const isGroup = ev.message_type === 'group'
    const key = isGroup ? `group:${ev.group_id}` : `private:${ev.user_id}`
    if (!this.#allow(ev)) {
      this.pushLog('deny', `${key} ${String(ev.raw_message ?? '').slice(0, 80)}`)
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
    if (records.length > 0) {
      const caps = await this.#voiceStatus()
      if (caps.asr.ok) {
        const transcript = await this.#transcribeRecords(key, records)
        if (transcript) text = text ? `${transcript}\n${text}` : transcript
      } else {
        unhearable = true
        this.pushLog('voice-skip', `${key} 没装语音识别：${caps.asr.reason}`)
      }
    }
    if (!text) {
      if (unhearable) await this.#noticeVoiceUnavailable(key, ev)
      this.pushLog('skip', `${key} 只有非文字内容`)
      return
    }

    if (isGroup && !this.#admitGroup(ev, segments, text)) return

    this.pushLog('in', `${key} ${text.slice(0, 200)}`)

    const record = await this.#ensure(key, isGroup, ev)
    if (!record) return

    const reset = /^\/reset\b/i.test(text)
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

  async #ensure(key, isGroup, ev) {
    const hit = this.records.get(key)
    if (hit) return hit

    const sessionId = `seedqq-${sha1(key).slice(0, 16)}`
    const cwd = String(this.config.cwd ?? '').trim() || undefined
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

    if (!agent) {
      try {
        const handle = await this.agents.resume({
          resumeSessionId: sessionId,
          ...(this.#agentOptions() ? { agentOptions: this.#agentOptions() } : {}),
          ...(cwd ? { meta: { cwd } } : {}),
        })
        if (handle?.agent) {
          agent = handle.agent
          dispose = handle.dispose
          owned = true
        }
      } catch (error) {
        this.pushLog('debug', `resume ${sessionId.slice(0, 8)} 未命中：${error?.message ?? error}`)
      }
    }

    if (!agent) {
      try {
        const handle = await this.agents.create({
          sessionId,
          ...(cwd ? { meta: { cwd } } : {}),
          ...(this.#agentOptions() ? { agentOptions: this.#agentOptions() } : {}),
        })
        if (!handle?.agent) throw new Error('agents.create 没有返回 agent')
        agent = handle.agent
        dispose = handle.dispose
        owned = true
      } catch (error) {
        this.pushLog('error', `创建会话失败 ${key}：${error?.message ?? error}`)
        return null
      }
    }

    const record = {
      key,
      sessionId,
      scope: isGroup ? 'group' : 'private',
      peerId: isGroup ? ev.group_id : ev.user_id,
      agent,
      dispose: owned ? dispose : null,
      chain: Promise.resolve(),
      queueDepth: 0,
      lastActive: Date.now(),
    }
    this.records.set(key, record)
    this.pushLog('ready', `${key} → ${sessionId}`)
    return record
  }

  async #reset(record) {
    try {
      await record.dispose?.()
    } catch {
      /* ignore */
    }
    this.records.delete(record.key)
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
        this.waiters.delete(sessionId)
        resolve(this.waiters.get(sessionId)?.text ?? '')
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

  async #turn(record, text) {
    const factory = await userMessageFactory()
    const message = factory({ content: [{ type: 'text', text }], source: { kind: 'user' } })
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
    if (!reply) {
      this.pushLog('silent', record.key)
      return
    }
    await this.#send(record, reply)
  }

  async #transcribeRecords(key, records) {
    const voiceDir = String(this.config.voiceDir ?? '').trim()
    if (!voiceDir) return ''
    const lines = []
    for (const seg of records.slice(0, 2)) {
      const path = await resolveRecordFile({
        client: this.client,
        seg,
        dir: voiceDir,
        logger: this.logger,
      })
      if (!path) {
        this.pushLog('voice-skip', `${key} 语音文件拿不到`)
        continue
      }
      const result = await transcribeFile(this.config, path)
      if (!result.ok) {
        this.pushLog('voice-error', `${key} ASR：${result.error}`)
        continue
      }
      this.pushLog('voice-in', `${key} ${result.text.slice(0, 120)}`)
      lines.push(`（语音）${result.text}`)
    }
    return lines.join('\n')
  }

  async #send(record, text) {
    if (await this.#canSpeak(text)) {
      const spoken = await this.#sendVoice(record, text)
      if (spoken) return
    }
    const bubbles =
      this.config.burst === false
        ? chunkText(text)
        : splitBubbles(text, Math.min(4, Math.max(1, Number(this.config.burstMax) || 3)))
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
        this.pushLog('send-error', `${record.key} ${String(error?.message ?? error)}`)
      }
    }
    this.#noteSpoken(record.key)
  }

  async #voiceStatus(force = false) {
    return this.voiceProbe.get(this.config, { force })
  }

  /** 现在能不能说：配置允许、这句话适合说、并且 TTS 真的在。 */
  async #canSpeak(text) {
    const mode = String(this.config.voiceOut ?? 'auto').toLowerCase()
    if (mode === 'off' || mode === 'false') return false
    if (mode !== 'always' && !looksSpeakable(text, this.config.voiceMaxChars)) return false
    const caps = await this.#voiceStatus()
    if (!caps.tts.ok) {
      const now = Date.now()
      if (now - this.ttsWarnAt > 10 * 60_000) {
        this.ttsWarnAt = now
        this.pushLog('tts-skip', `这次走文字：${caps.tts.reason}`)
      }
      return false
    }
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
      this.pushLog('voice', `${record.key} ${file} ${audioSize(result.path)}B`)
      return true
    } catch (error) {
      this.pushLog('voice-error', `${record.key} ${String(error?.message ?? error)}`)
      return false
    }
  }
}
