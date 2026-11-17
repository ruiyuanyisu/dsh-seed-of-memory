import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createConnection } from 'node:net'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openDatabase, closeDatabase } from './db.js'
import { backupDaily, backupStatus } from './backup.js'
import { rotateLog } from './logfile.js'
import { IdentityFiles } from './identity.js'
import { SeedStore } from './store.js'
import { Qing, TONE_LABELS, scoreText as scoreQing } from './qing.js'
import { defaultEnv, detect as detectCompat, othersActive, readSource as readCompatSource, importRecords, exportSnapshot, sharedBudget } from './compat.js'
import {
  currentMood,
  recordEmotion,
  recentEmotions,
  emotionValence,
  affectLine,
  listAffects,
  ensureAffects,
  moveAffect,
  decayAffects,
  AFFECT_KINDS,
} from './affect.js'
import { getBelief, listBeliefs, rememberBelief, setBeliefStatus } from './beliefs.js'
import { ExternalIndex, DEFAULT_SOURCES } from './external.js'
import { EmbeddingRuntime, autoInitEnabled } from './embedding.js'
import { behaviorLine, reflectTurn } from './reflect.js'
import { SemanticIndex, DEFAULT_SPACE, EXTRA_MIN_SCORE } from './semantic.js'
import { backfillTiers, planConsolidation, applyConsolidation, consolidationView } from './consolidate.js'
import { OneBotClient } from './qq/onebot.js'
import { QqChannel } from './qq/channel.js'
import { PROACTIVE_DEFAULTS, planProactive, proactiveText, ownerTarget, normalizeOwnerQQ } from './qq/proactive.js'
import { normalizeQqConfig } from './qq/settings.js'
import { setContact, getContact, listContacts, forgetContact, contactLine, parsePeer } from './contacts.js'
import { addLoose, listLoose, closeLoose, looseLines, markReplied, extractQuestion } from './loose.js'
import { voiceCapability, VOICE_HINT, VOICE_NOTICE } from './voice.js'
import {
  getAspiration,
  setAspiration,
  listTraits,
  observeTrait,
  decayTraits,
  fitScore,
  personaLine,
  personaSummary,
} from './persona.js'
import {
  ensureDefaultHabits,
  getHabit,
  listHabits,
  observeHabit,
  styleLine,
  styleSummary,
} from './style.js'
import { canonScope, DEFAULT_WRITE_SCOPE, scopeFilter, scopeOfSessionId, visibleScopes } from './scope.js'
import {
  acceptCapture,
  addCapture,
  captureLine,
  captureStats,
  expireCaptures,
  extractCandidates,
  isKnown,
  KNOWN_THRESHOLD,
  listCaptures,
  markCapture,
  matchCapture,
} from './capture.js'
import { diskStatus, storageLine, DEFAULT_MIN_FREE_MB } from './disk.js'
import { collectBiliCandidates, summarizeReports } from './bili.js'

const GUIDE_TEXT = (() => {
  try {
    return readFileSync(new URL('../docs/GUIDE.md', import.meta.url), 'utf8')
  } catch {
    return ''
  }
})()

const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? null
  } catch {
    return null
  }
})()

export const RESOURCE_LINKS = {
  release: 'https://github.com/ruiyuanyisu/dsh-seed-of-memory/releases',
  xunlei: 'https://pan.xunlei.com/s/VP6ISBPslAOekvaS7k23N_s2A1A#',
  xunleiCode: 'vmys',
}

export const name = 'seed-of-memory'
export const inject = ['tools', 'agents', 'systemPrompt']

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string' } },
  required: ['text'],
}

function stateDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'seed-of-memory')
}

function stateFile() {
  const dir = stateDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'seed.db')
}

/** Sources come from plugin config, then <stateDir>/sources.json, then defaults (none). */
function loadSources(config) {
  if (Array.isArray(config.sources) && config.sources.length > 0) return config.sources
  try {
    const file = join(stateDir(), 'sources.json')
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    }
  } catch (error) {
    console.error('[seed-of-memory] 读取 sources.json 失败：' + (error?.message ?? error))
  }
  return DEFAULT_SOURCES
}

function textResult(text) {
  return { text: String(text ?? '') }
}

function loadQqConfig(config) {
  const base = { ...QqChannel.defaults(), ...(config?.qq ?? {}) }
  try {
    const file = join(stateDir(), 'qq.json')
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      // qq.json 是给人手改的：数组写成字符串、布尔写成 "false" 都收回来，别让怪值沉默地改变行为。
      return normalizeQqConfig({ ...base, ...(saved && typeof saved === 'object' ? saved : {}) })
    }
  } catch (error) {
    console.error('[seed-of-memory] 读取 qq.json 失败：' + (error?.message ?? error))
  }
  return normalizeQqConfig(base)
}

function saveQqConfig(config) {
  try {
    const file = join(stateDir(), 'qq.json')
    writeFileSync(file, JSON.stringify(config, null, 2), 'utf8')
  } catch (error) {
    console.error('[seed-of-memory] 写入 qq.json 失败：' + (error?.message ?? error))
  }
}

function appendQqLog(entry) {
  try {
    const file = join(stateDir(), 'qq.log')
    rotateLog(file)
    appendFileSync(file, `${new Date(entry.at).toISOString()} ${entry.kind} ${entry.text}\n`, 'utf8')
  } catch {
    /* 日志失败不影响消息 */
  }
}

function maskQqConfig(config) {
  const token = String(config.accessToken ?? '')
  return {
    ...config,
    accessToken: token ? `${token.slice(0, 4)}…${token.slice(-4)}` : '',
    hasToken: Boolean(token),
  }
}

function portOf(url, fallback) {
  try {
    const parsed = new URL(String(url ?? ''))
    return Number(parsed.port) || fallback
  } catch {
    return fallback
  }
}

/** 只做一次 TCP 握手，判断本机端口开没开。 */
function probePort(port, host = '127.0.0.1', timeoutMs = 700) {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(ok)
    }
    const socket = createConnection({ port, host })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** 问 OneBot 要一下登录信息；拿不到就返回 null + 原因。 */
async function oneBotLogin(httpUrl, accessToken) {
  try {
    const base = String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '')
    const res = await fetch(`${base}/get_login_info`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: '{}',
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return { login: null, error: `HTTP ${res.status}` }
    const body = await res.json()
    const data = body?.data ?? null
    return { login: data, error: data ? '' : '没有返回登录信息' }
  } catch (error) {
    return { login: null, error: String(error?.message ?? error) }
  }
}

function tool(name, description, parameters, run) {
  return {
    name,
    description,
    parameters: { type: 'object', additionalProperties: false, properties: parameters.properties, required: parameters.required ?? [] },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args, exec) {
      return textResult(await run(args ?? {}, exec))
    },
  }
}

function describeRow(row) {
  const when = new Date(Number(row.occurred_at ?? row.recorded_at))
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`
  return `${row.id.slice(0, 12)} [${row.layer}/${row.source}] ${stamp} ${row.text}`
}

export function apply(ctx, rawConfig = {}) {
  const config = { budget: 600, coreBudget: 1200, diskMinFreeMB: 300, sharedBudgetRatio: 0.6, ...(rawConfig || {}) }
  const db = openDatabase(stateFile())
  const store = new SeedStore(db)

  // 启动时顺手做一份当日快照：一天一次、只留 3 份，失败了也不影响用。
  backupDaily(db, stateFile(), stateDir(), { keep: 3 })

  // 别家记忆插件也在场时，卡片让一点预算出来；只有我们时一分不让。
  let sharedCache = { at: 0, others: [] }
  function otherMemoryPlugins() {
    const now = Date.now()
    if (now - sharedCache.at < 60_000) return sharedCache.others
    try {
      sharedCache = { at: now, others: othersActive(defaultEnv()) }
    } catch {
      sharedCache = { at: now, others: [] }
    }
    return sharedCache.others
  }

  function cardBudget() {
    return sharedBudget(Number(config.budget) || 600, config.sharedBudgetRatio, otherMemoryPlugins())
  }

  // 情绪内核：不靠模型自觉，收件箱进来一句话就打一次分。
  const qing = new Qing(db, {
    baseline: Number(config.emotionBaseline) || 50,
    recordAt: Number(config.emotionRecordAt) || 0.3,
    extraPraise: Array.isArray(config.extraPraise) ? config.extraPraise : [],
    extraBlame: Array.isArray(config.extraBlame) ? config.extraBlame : [],
    extraSoft: Array.isArray(config.extraSoft) ? config.extraSoft : [],
  })
  const emotionOn = config.emotion !== false

  // 阴晴也在场时不重复报情绪：它那份是「此刻」的，别让两边打起来。
  let yinqingCache = { at: 0, present: false }
  function yinqingPresent() {
    const now = Date.now()
    if (now - yinqingCache.at < 60_000) return yinqingCache.present
    let present = false
    try {
      present = existsSync(join(defaultEnv().dshHome, 'mood', 'state.json'))
    } catch {
      present = false
    }
    yinqingCache = { at: now, present }
    return present
  }

  function emotionLine(slot = null) {
    if (!emotionOn) return ''
    if (yinqingPresent()) return ''
    try {
      // 带档：卡片上「最近那一下」不该挂别人的事（REVIEW-151 第六轮）。
      return qing.line(Date.now(), slot)
    } catch {
      return ''
    }
  }
  const identity = new IdentityFiles(stateDir()).ensure()
  const sources = loadSources(config)
  const external = new ExternalIndex(db, sources)
  const embedding = new EmbeddingRuntime({
    stateDir: stateDir(),
    port: Number(config.embeddingPort) || 11435,
    logger: console,
    extraScanDirs: Array.isArray(config.embeddingScanDirs) ? config.embeddingScanDirs : [],
  })

  const embedInfo = embedding.versionInfo?.() ?? null
  const semantic = new SemanticIndex(db, embedding, {
    space: embedInfo?.modelSpace || DEFAULT_SPACE,
    dimension: Number(embedInfo?.dimension) || 512,
    model: embedInfo?.modelTag || '',
    logger: console,
    batch: Number(config.embeddingBatch) || 16,
  })

  let semanticTimer = null
  const RELATED_MIN = 0.55

  // —— QQ 通道（SnowLuma / OneBot）——
  const qqConfig = loadQqConfig(config)
  qqConfig.proactive = { ...PROACTIVE_DEFAULTS, ...(qqConfig.proactive ?? {}) }
  // 主人默认能说话：ownerQQ 自动进私聊白名单（保存时落盘）
  const ownerQQ = normalizeOwnerQQ(qqConfig.ownerQQ)
  if (ownerQQ && !qqConfig.allowPrivate.includes(ownerQQ)) {
    qqConfig.allowPrivate = [...qqConfig.allowPrivate, ownerQQ]
  }
  let qq = null
  let qqClient = null
  /** 主动消息是发给老大的，用的也该是「我对老大」这一档：别人惹我的事不往里带。 */
  function ownerScope() {
    return ownerQQ ? `qq:${ownerQQ}` : 'gui'
  }
  const qqDisposers = []
  // 上一次建通道时的连接参数。保存设置时拿来比对：没变就不重建，免得改个白名单也断一下。
  let qqBuildSignature = ''

  // 设置存盘后要不要重建通道：改了什么就重建，一个字没改就什么都不动。
  function configSignature(config) {
    try {
      return JSON.stringify(config ?? {})
    } catch {
      return ''
    }
  }

  // 让插件自己建的会话挂进对应的工作区，而不是掉进侧栏的「未分组」。
  // dsh-workspace 只认「会话 header 的 cwd 和工作区路径完全一致」，所以按 cwd 找。
  async function attachSessionToWorkspace(sessionId, cwd) {
    const registry = ctx.get?.('workspaceRegistry')
    if (!registry || typeof registry.list !== 'function') return false
    const norm = (value) => String(value ?? '').trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
    const want = norm(cwd)
    if (!want) return false
    const workspace = registry.list().find((item) => norm(item?.path) === want)
    if (!workspace) return false
    try {
      await workspace.attachSession(sessionId)
      return true
    } catch {
      // 刚 create 完 header 还没落盘时会抛，交给 channel 那边隔一会儿重试，这里别刷屏
      return false
    }
  }

  function rebuildQq({ start = false } = {}) {
    qqBuildSignature = configSignature(qqConfig)
    try {
      qq?.stop()
    } catch {
      /* ignore */
    }
    // 模块重载后旧实例的 socket 仍在进程里；集中清一次，避免同一账号多条连接
    for (const stale of globalThis.__seedOfMemoryQqClients ?? []) {
      try {
        stale.close?.()
      } catch {
        /* ignore */
      }
    }
    globalThis.__seedOfMemoryQqClients = new Set()
    for (const off of qqDisposers.splice(0)) {
      try {
        off()
      } catch {
        /* ignore */
      }
    }
    qq = null
    qqClient = null
    if (!qqConfig.wsUrl && !qqConfig.httpUrl) return
    try {
      qqClient = new OneBotClient({
        wsUrl: qqConfig.wsUrl,
        httpUrl: qqConfig.httpUrl,
        token: qqConfig.accessToken ?? '',
        logger: console,
      })
      globalThis.__seedOfMemoryQqClients?.add(qqClient)
      qqConfig.voiceDir = qqConfig.voiceDir || join(stateDir(), 'qq-voice')
      // QQ 会话不靠宿主落盘，本地留一小截「刚才」（见 lib/qq/history.js）
      qqConfig.historyFile = qqConfig.historyFile || join(stateDir(), 'qq-history.json')
      qqConfig.asrScript =
        qqConfig.asrScript || fileURLToPath(new URL('../asr/asr_once.py', import.meta.url))
      qq = new QqChannel({
        client: qqClient,
        agents: ctx.agents,
        config: qqConfig,
        logger: console,
        onLog: appendQqLog,
        // 群里判断「现在想不想说话」，要的是此刻的情绪。
        // 以前这儿读的是 mood 表，那张表只有 seed_feel 会写，平时一动不动——
        // 结果群里永远按「电量满格」算，跟面板上的积极性完全脱钩。
        getMood: () => moodForJudgement(),
        attachWorkspace: attachSessionToWorkspace,
        // QQ 会话的工具是精简过的，没有 read_image——图得走 attachment store 变成 image block。
        // 用 ctx.get 取值：直接写 ctx.attachments 在服务还没注册时是抛错的，
        // 那样整个 apply 会炸，连 QQ 通道都起不来。
        attachments: ctx.get?.('attachments') ?? null,
        // 我说出去的话里要等回音的那句 → 未完话头
        onAsked: (record, text) => {
          if (config.looseEnds === false) return
          try {
            const ask = extractQuestion(text)
            if (!ask) return
            addLoose(db, {
              peer: record.key,
              ask,
              sessionId: record.sessionId,
              hours: Number(config.looseHours) || 48,
            })
          } catch (error) {
            console.warn('[seed-of-memory] 未完话头记不下：' + (error?.message ?? error))
          }
        },
        // 他回话了：把没落定的标成「已回话」，等我在这一轮里判断怎么收
        onReplied: (key) => {
          try {
            markReplied(db, key)
          } catch (error) {
            console.warn('[seed-of-memory] 未完话头更新失败：' + (error?.message ?? error))
          }
        },
      })
      const off = ctx.on?.('session/event', (session, event) => {
        try {
          qq?.onSessionEvent(session, event)
        } catch (error) {
          console.warn('[seed-of-memory] QQ 事件处理失败：' + (error?.message ?? error))
        }
      })
      if (typeof off === 'function') qqDisposers.push(off)
      if (start || qqConfig.enabled) qq.start()
    } catch (error) {
      console.error('[seed-of-memory] QQ 通道初始化失败：' + (error?.message ?? error))
    }
  }

  rebuildQq()

  // —— 主动找主人：心情/依恋到了合适的时候，主动说一句 ——
  const proactiveFile = join(stateDir(), 'qq-proactive.json')
  let proactiveTimer = null

  function localDay(now = Date.now()) {
    const d = new Date(now)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  function readProactiveState() {
    try {
      const saved = JSON.parse(readFileSync(proactiveFile, 'utf8'))
      return {
        lastAt: Number(saved?.lastAt) || 0,
        day: String(saved?.day ?? ''),
        count: Number(saved?.count) || 0,
        lastUserAt: Number(saved?.lastUserAt) || 0,
        lastKind: String(saved?.lastKind ?? ''),
        lastReason: String(saved?.lastReason ?? ''),
      }
    } catch {
      return { lastAt: 0, day: '', count: 0, lastUserAt: 0, lastKind: '', lastReason: '' }
    }
  }

  let proactiveState = readProactiveState()

  function saveProactiveState() {
    try {
      writeFileSync(proactiveFile, JSON.stringify(proactiveState, null, 2), 'utf8')
    } catch (error) {
      console.error('[seed-of-memory] 写入 qq-proactive.json 失败：' + (error?.message ?? error))
    }
  }

  /**
   * 主动开口时随手拎一条记忆当引子。
   *
   * 必须按档取（REVIEW-151 第十五轮）：原来不带 scope，从全库最近 30 条里随机抽，
   * 于是张三在私聊里说的「我今天做手术」会被抽出来、安到老大头上讲——
   * 「我想起你上次说……我今天做手术」。不是读错，是把别人的事安到你身上。
   * 默认 'gui' 是为了「谁调用忘了传」时至少只碰当面和共用那两档。
   */
  function memorySeed(scope = DEFAULT_WRITE_SCOPE) {
    try {
      const visible = scopeFilter('scope', scope)
      const rows = db
        .prepare(
          `SELECT text FROM memories WHERE layer IN ('episodic','semantic') AND status = 'active' AND ${visible.sql} ORDER BY recorded_at DESC LIMIT 30`,
        )
        .all(...visible.params)
      if (!rows.length) return ''
      const row = rows[Math.floor(Math.random() * rows.length)]
      return String(row?.text ?? '')
    } catch {
      return ''
    }
  }

  /**
   * 「现在心情怎么样」——统一从情绪内核取，别再读 mood 表。
   * 那张表只有 seed_feel 会写，平时一动不动，群聊电量会一直卡在满格。
   */
  function moodForJudgement(now = Date.now()) {
    try {
      const snap = qing.snapshot(now)
      const level = Number(snap?.mood)
      if (!Number.isFinite(level)) return currentMood(db)
      return {
        valence: Math.max(-1, Math.min(1, (level - 50) / 50)),
        arousal: Math.max(0, Math.min(1, Number(snap?.energy ?? 60) / 100)),
        label: String(snap?.line ?? '').split(/[，,]/)[0].trim(),
        cause: '',
      }
    } catch {
      return currentMood(db)
    }
  }

  function proactiveDecision(now = Date.now()) {
    const cfg = { ...PROACTIVE_DEFAULTS, ...(qqConfig.proactive ?? {}) }
    const today = localDay(now)
    const dayCount = proactiveState.day === today ? proactiveState.count : 0
    if (qq?.lastInboundAt) proactiveState.lastUserAt = qq.lastInboundAt
    const lastUserAtRaw = Number(qq?.lastInboundAt || proactiveState.lastUserAt || 0)
    // 刚重启、还没收到过消息时不要把「从没说过话」当成 lonely
    const lastUserAt = lastUserAtRaw || now - 2 * 3_600_000
    const plan = planProactive({
      now,
      mood: moodForJudgement(now),
      affects: listAffects(db, { now, slot: ownerScope() }),
      lastAt: proactiveState.lastAt,
      lastUserAt,
      dayCount,
      config: cfg,
      qing: emotionOn ? qing.snapshot(now, ownerScope()) : {},
    })
    return { ...plan, dayCount, lastAt: proactiveState.lastAt, lastUserAt }
  }

  async function proactiveTick({ force = false, voice = null } = {}) {
    if (!qq || !qqConfig.enabled) return { sent: false, reason: 'QQ 未启用' }
    if (!qq.status().connected) return { sent: false, reason: '还没连上' }
    const target = ownerTarget({ ownerQQ: qqConfig.ownerQQ, target: qqConfig.proactive?.target })
    if (!target) return { sent: false, reason: '还没填主人 QQ' }
    const now = Date.now()
    const plan = proactiveDecision(now)
    if (!force && !plan.send) return { sent: false, plan }
    const kind = plan.send ? plan.kind : 'miss'
    // 发到哪个目标，就取那个目标的档（REVIEW-151 第十五轮）：
    // 没填 ownerQQ 时 target 可以是个群，那时候拿老大的档去挑记忆和心情，说出来的话不合场合。
    const talkScope = target.startsWith('group:') ? target : ownerScope()
    const text = proactiveText(kind, { memory: memorySeed(talkScope), name: '你', qing: emotionOn ? qing.snapshot(now, talkScope) : {} })
    if (!text) return { sent: false, reason: '没想出说什么' }
    const ok = await qq.say(target, text, { voice: voice ?? Boolean(qqConfig.proactive?.voice) })
    if (!ok) return { sent: false, reason: '发送失败', text }
    const today = localDay(now)
    proactiveState.lastAt = now
    proactiveState.lastKind = kind
    proactiveState.lastReason = plan.reason || (force ? '手动触发' : '')
    proactiveState.count = (proactiveState.day === today ? proactiveState.count : 0) + 1
    proactiveState.day = today
    if (qq?.lastInboundAt) proactiveState.lastUserAt = qq.lastInboundAt
    saveProactiveState()
    appendQqLog({ at: now, kind: 'proactive', text: `${target} [${kind}] ${text.slice(0, 160)}` })
    return { sent: true, kind, text, reason: plan.reason || '手动触发' }
  }

  function startProactive() {
    if (proactiveTimer) return
    proactiveTimer = setInterval(() => {
      proactiveTick().catch((error) => {
        console.warn('[seed-of-memory] 主动消息失败：' + (error?.message ?? error))
      })
    }, 10 * 60_000)
    proactiveTimer.unref?.()
  }

  startProactive()

  /** 第一次接 QQ 的向导：逐步告诉用户卡在哪，全部只读探测。 */
  async function qqOnboarding() {
    const status = qq ? qq.status() : null
    const httpPort = portOf(qqConfig.httpUrl, 3000)
    const wsPort = portOf(qqConfig.wsUrl, 3001)
    const [httpOpen, wsOpen] = await Promise.all([probePort(httpPort), probePort(wsPort)])
    const probe = httpOpen
      ? await oneBotLogin(qqConfig.httpUrl, qqConfig.accessToken)
      : { login: null, error: `HTTP ${httpPort} 没开` }
    const bound = (qqConfig.allowPrivate?.length ?? 0) + (qqConfig.allowGroups?.length ?? 0) > 0
    const steps = [
      {
        id: 'snowluma',
        title: '装好 SnowLuma 并启动',
        done: httpOpen || wsOpen,
        hint: '下载 SnowLuma 解压后双击 launcher.bat；它自带 Node，不用另装。',
      },
      {
        id: 'login',
        title: '登录 QQ',
        done: Boolean(probe.login),
        hint: '浏览器打开 http://127.0.0.1:5099，扫码登录要挂机的 QQ 号。',
      },
      {
        id: 'onebot',
        title: '打开 OneBot 11',
        done: httpOpen && wsOpen,
        hint: `SnowLuma → 设置 → OneBot：HTTP ${httpPort} 与 WebSocket ${wsPort} 都打开，用同一个 accessToken。`,
      },
      {
        id: 'bind',
        title: '填白名单',
        done: bound,
        hint: '在下面填 allowPrivate（私聊 QQ 号）或 allowGroups（群号）；不填不会回任何人。',
      },
      {
        id: 'connect',
        title: 'Seed 连上 OneBot',
        done: Boolean(status?.connected),
        hint: '点「保存并重连」；日志出现 status connected 就成了。',
      },
    ]
    return {
      steps,
      next: steps.find((step) => !step.done)?.id ?? 'done',
      httpPort,
      wsPort,
      httpOpen,
      wsOpen,
      login: probe.login,
      loginError: probe.error,
      bound,
      webui: 'http://127.0.0.1:5099',
      status,
    }
  }

  // —— 与「刷B站」插件兼容：把它的日报变成待记候选 ——
  const biliOutDir = String(config.biliOutDir || join(homedir(), '.dsh', 'bili-duty', 'out'))
  const biliSyncFile = join(stateDir(), 'bili-sync.json')
  let biliSync = { seen: [] }
  try {
    if (existsSync(biliSyncFile)) biliSync = JSON.parse(readFileSync(biliSyncFile, 'utf8'))
  } catch {
    biliSync = { seen: [] }
  }

  function syncBili({ days = 3, dry = false } = {}) {
    const candidates = collectBiliCandidates({ dir: biliOutDir, days, max: 20 })
    const seen = new Set(Array.isArray(biliSync.seen) ? biliSync.seen : [])
    let added = 0
    const lines = []
    for (const item of candidates) {
      if (seen.has(item.videoId)) continue
      lines.push(item.text)
      if (dry) continue
      addCapture(db, { sessionId: 'bili', text: item.text, cue: 'new', slot: 'gui' })
      seen.add(item.videoId)
      added += 1
    }
    if (!dry) {
      biliSync = { seen: [...seen].slice(-300), at: Date.now() }
      try {
        writeFileSync(biliSyncFile, JSON.stringify(biliSync), 'utf8')
      } catch {}
    }
    return { added, candidates: candidates.length, lines, dir: biliOutDir }
  }

  if (config.biliSync !== false) {
    const firstSync = setTimeout(() => {
      try {
        syncBili()
      } catch {}
    }, 6000)
    firstSync.unref?.()
    const biliTimer = setInterval(() => {
      try {
        syncBili()
      } catch {}
    }, 6 * 60 * 60_000)
    biliTimer.unref?.()
  }

  async function semanticRelated(query) {
    const q = String(query ?? '').trim()
    if (!q || q.length < 2) return []
    const wanted = [
      ['belief', (id) => getBelief(db, id)?.claim, '认知'],
      ['habit', (id) => getHabit(db, id)?.statement, '习惯'],
      ['trait', (id) => listTraits(db, { limit: 200 }).find((row) => row.id === id), '性格'],
    ]
    const out = []
    for (const [type, lookup, label] of wanted) {
      let scores = null
      try {
        scores = await semantic.queryScores(q, { refType: type, limit: 3 })
      } catch {
        scores = null
      }
      if (!scores) continue
      for (const [id, cosine] of scores) {
        if (cosine < RELATED_MIN) continue
        const row = lookup(id)
        let text = ''
        if (type === 'trait') text = row?.statement || row?.name || ''
        else text = row || ''
        if (!text) continue
        out.push({ type: label, text, cosine })
      }
    }
    out.sort((a, b) => b.cosine - a.cosine)
    return out.slice(0, 3)
  }

  // 库已经关了（插件被卸下、会话收尾、测试跑完）时，后台这几件小事本来就不该再跑，
  // 报出来只是噪音；别的错照旧报。
  const isDbGone = (error) =>
    /database is not open|database is closed|database connection is not open/i.test(String(error?.message ?? error))

  function semanticTick() {
    if (config.semanticEnabled === false) return
    if (semantic.busy) return
    if (!semantic.stats().pending) return
    // 一轮里连续补，直到补完、或者这次 tick 已经花掉 4 秒。
    // 原来是一个 tick 只补 16 条就歇 20 秒：实测一条向量 8ms，16 条 0.13 秒，
    // 剩下 19.8 秒全在干等 —— 一千条要补二十一分钟。
    const size = Math.max(1, Number(config.embeddingBatch) || 16)
    const started = Date.now()
    const pump = async () => {
      while (Date.now() - started < 4000) {
        const step = await semantic.backfill({ batch: size })
        if (!step.embedded) return
        if (Number(step.remaining) <= 0) return
        if (step.skipped) return
      }
    }
    void pump().catch((error) => {
      if (isDbGone(error)) return
      console.error('[seed-of-memory] 语义索引回填失败：' + (error?.message ?? error))
    })
  }
  try {
    const warmSemantic = setTimeout(semanticTick, 9000)
    warmSemantic.unref?.()
    semanticTimer = setInterval(semanticTick, 20_000)
    semanticTimer.unref?.()
  } catch {}

  // —— 巩固（v0.11）：先给旧数据补 tier，再定期把够格的短期记忆升为长期 ——
  let consolidationTimer = null
  const consolidateTick = () => {
    try {
      decayAffects(db)
      const actions = planConsolidation(db, { limit: 200 })
      if (actions.length) applyConsolidation(db, actions)
    } catch (error) {
      if (isDbGone(error)) return
      console.error('[seed-of-memory] 巩固失败：' + (error?.message ?? error))
    }
  }
  try {
    backfillTiers(db)
    ensureAffects(db)
    decayAffects(db)
    const warmConsolidate = setTimeout(() => {
      consolidateTick()
      consolidationTimer = setInterval(consolidateTick, 30 * 60_000)
      consolidationTimer.unref?.()
    }, 12_000)
    warmConsolidate.unref?.()
  } catch (error) {
    console.error('[seed-of-memory] 巩固定时器不可用：' + (error?.message ?? error))
  }

  // 启动时：装了运行时就拉起来；没装但下载目录里有安装包，按配置自动装。
  // 语义检索关掉的时候这些都不做 —— 装运行时要解压几百兆、起了还常驻内存，白费。
  try {
    if (autoInitEnabled(config)) {
      const auto = setTimeout(() => {
        void (async () => {
          try {
            const status = await embedding.status()
            if (status.installed) {
              if (config.embeddingAutoStart !== false && !status.running) await embedding.start()
              return
            }
            if (config.embeddingAutoInstall === false) return
            const found = embedding.scan()
            if (!found.length) return
            const result = await embedding.install(found[0].path)
            if (result.ok && config.embeddingAutoStart !== false) await embedding.start()
          } catch (error) {
            console.error('[seed-of-memory] embedding 自动初始化失败：' + (error?.message ?? error))
          }
        })()
      }, 3000)
      auto.unref?.()
    }
  } catch {}

  let scanTimer = null
  let scanPending = null
  function scanExternal(force = false) {
    if (scanPending) return scanPending
    scanPending = new Promise((resolve) => {
      setImmediate(() => {
        try {
          resolve(external.scan({ force }))
        } catch (error) {
          // 库已经关了时这次扫描本来就不该发生，报出来只是噪音。别的错照旧报。
          if (!isDbGone(error)) console.error('[seed-of-memory] 档案扫描失败：' + (error?.message ?? error))
          resolve(null)
        } finally {
          scanPending = null
        }
      })
    })
    return scanPending
  }
  try {
    const warm = setTimeout(() => void scanExternal(), 1500)
    warm.unref?.()
    scanTimer = setInterval(() => void scanExternal(), 10 * 60 * 1000)
    scanTimer.unref?.()
  } catch {}

  try {
    decayTraits(db)
    const decayTimer = setInterval(() => decayTraits(db), 6 * 60 * 60 * 1000)
    decayTimer.unref?.()
  } catch {}

  try {
    ensureDefaultHabits(db)
  } catch (error) {
    console.error('[seed-of-memory] 说话习惯初始化失败：' + (error?.message ?? error))
  }

  try {
    expireCaptures(db)
    const captureTimer = setInterval(() => expireCaptures(db), 60 * 60 * 1000)
    captureTimer.unref?.()
  } catch (error) {
    console.error('[seed-of-memory] 候选队列初始化失败：' + (error?.message ?? error))
  }

  function describeArchive(hit) {
    return `[档案] ${hit.label}/${hit.rel}#${hit.line} ${hit.snippet}`
  }

  // ---------- tools ----------
  /**
   * 按「id 或 id 前缀」找一条记忆。
   * 前缀常常对上不止一条（同一毫秒写的两条，id 前半段一样），
   * 这种时候要把候选列出来，不能闷头取第一条 —— 尤其 seed_forget 是彻底删除。
   */
  function resolveMemory(raw, { limit = 500, scope = null } = {}) {
    const text = String(raw ?? '').trim()
    if (text.length < 4) return { row: null, matches: [], short: true }
    // 给了会话档位就只在这个人看得见的范围里找：不然 /seed open 别人的 id 也能翻出来。
    const visible = scope ? new Set(visibleScopes(scope)) : null
    const exact = store.get(text)
    if (exact && (!visible || visible.has(canonScope(exact.scope)))) {
      return { row: exact, matches: [exact], short: false }
    }
    const matches = store.list({ limit, includeRetired: true, scope }).filter((row) => row.id.startsWith(text))
    return { row: matches.length === 1 ? matches[0] : null, matches, short: false }
  }

  /** 档位的口头说法，命令里用（面板里那份在 client.js，两边别互相引）。 */
function scopeLabelText(scope) {
  const value = String(scope ?? 'shared')
  if (value === 'shared') return '共用'
  if (value === 'gui') return '当面'
  if (value.startsWith('qq:')) return `QQ ${value.slice(3)}`
  if (value.startsWith('group:')) return `群 ${value.slice(6)}`
  return value
}

function ambiguousNote(matches) {    const lines = matches
      .slice(0, 6)
      .map((row) => `- ${row.id}  ${String(row.text ?? '').slice(0, 30)}`)
    return `这个前缀对上 ${matches.length} 条，先说清是哪一条：\n${lines.join('\n')}`
  }

  const tools = [
    tool(
      'seed_remember',
      '记下一件值得长期记住的事（写进「记忆之种」）。一条只装一件事；' +
        '只有长期有价值的内容才值得写：他明确说的重要的话、约定、喜好、状态、你们之间发生的事。' +
        '不要记日常琐事，不要记重复内容。写的时候安静地写，不要在回复里汇报。',
      {
        properties: {
          text: { type: 'string', description: '要记住的事，一句话说清；人称用「他/你」之外的第三人称或原话。' },
          layer: {
            type: 'string',
            enum: ['persona', 'semantic', 'episodic', 'buffer'],
            description: 'persona=身份/称呼/长期设定；semantic=稳定事实与偏好；episodic=发生过的事；buffer=当前进行中的事。默认 episodic。',
          },
          factKey: { type: 'string', description: '可选，同一件事的稳定键，例如「他.称呼」「约定.位置」。同键只保留最新一条，旧条自动退休可追溯。' },
          importance: { type: 'number', description: '0–1，越接近 1 越重要（会优先出现在每轮记忆卡里）。' },
          emotion: { type: 'string', description: '可选，这条记忆关联的情绪词。' },
          confidence: { type: 'number', description: '0–1，来源越确定越高；推断来的写 0.5 以下。' },
          source: { type: 'string', enum: ['user-said', 'inferred', 'rule', 'import'], description: '默认 user-said；你的猜测写 inferred（不会进常驻卡）。' },
          scope: { type: 'string', description: '不填就跟着当前会话走（网页上记在当面，QQ 上记在这个人自己名下）；只有确实要写进「两人共用」那一层时才填 shared。' },
        },
        required: ['text'],
      },
      async (args, exec) => {
        if (!String(args.text ?? '').trim()) return '用法：seed_remember 要写一句要记的事，比如 text：「他说周末想去山里」。'
        // 谁在说就记在谁名下：工具参数不知道自己在哪个会话里，得从执行上下文取。
        // 拿不到会话时的兜底必须落在「当面」——原来退给 canonScope(args.scope)，
        // 没填 scope 就是 'shared'，而 shared 每一档都看得见：一次后台调用就把话漏给所有人
        // （REVIEW-151 第八轮）。命令那边一直退 'gui'，工具这边跟着对齐。
        const scope = scopeOfSession(agentSessionId(exec?.agent)) ?? canonScope(args.scope ?? DEFAULT_WRITE_SCOPE)
        const r = store.remember({ ...args, scope })
        try {
          matchCapture(db, args.text, r.id, scope)
        } catch {}
        if (config.semanticEnabled !== false) {
          void semantic.backfill({ batch: 1 }).catch(() => {})
        }
        return `已记住（${r.action}）：${r.id.slice(0, 12)}`
      },
    ),
    tool(
      'seed_search',
      '在「记忆之种」里检索长期记忆（FTS5 全文，中文按子串）。需要回忆细节时用。' +
        '默认同时查磁盘上的旧档案索引（只读，命中的是片段）；要看上下文再用 seed_open。',
      {
        properties: {
          q: { type: 'string', description: '检索词。' },
          limit: { type: 'number', description: '返回条数，默认 8。' },
          includeExternal: { type: 'boolean', description: '是否同时查旧档案（默认 true）。' },
        },
        required: ['q'],
      },
      async (args, exec) => {
        const mood = currentMood(db)
        const bias = {
          valence: mood.valence,
          weight: Number(config.moodBiasWeight) || 0.15,
          valenceOf: emotionValence,
        }
        const limit = Math.max(1, Math.min(30, Number(args.limit) || 8))
        const query = String(args.q ?? '')
        // 在哪个会话里搜，就只搜那一条能看见的：别人的私事不往这边翻。
        const scope = scopeOfSession(agentSessionId(exec?.agent))
        let scores = null
        if (config.semanticEnabled !== false) {
          // 先把「这一档看得见的」圈出来再算余弦：全库算完再被 SQL 挡掉，白算一堆。
          let visibleIds = null
          try {
            const visible = scopeFilter('scope', scope)
            visibleIds = db
              .prepare(`SELECT id FROM memories WHERE status = 'active' AND ${visible.sql}`)
              .all(...visible.params)
              .map((row) => row.id)
          } catch {
            visibleIds = null
          }
          try {
            scores = await semantic.queryScores(query, { ids: visibleIds })
          } catch (error) {
            console.error('[seed-of-memory] 语义检索失败，退回词法：' + (error?.message ?? error))
          }
        }
        const rows = store.search(query, {
          limit,
          bias,
          scope,
          semantic: scores
            ? {
                scores,
                weight: Number(config.semanticWeight) || 0.55,
                extraMin: Number(config.semanticExtraMin) || EXTRA_MIN_SCORE,
              }
            : null,
        })
        const lines = rows.map((row) => {
          const extra = row.cosine === null || row.cosine === undefined ? '' : ` · 语义 ${Number(row.cosine).toFixed(2)}`
          return `${describeRow(row)}  (score ${row.score.toFixed(2)}${extra})`
        })
        if (scores && rows.length) lines.unshift('（语义混合检索）')
        if (config.semanticEnabled !== false) {
          try {
            const related = await semanticRelated(query)
            if (related.length) {
              lines.push('— 相关认知/习惯/性格 —')
              for (const item of related) lines.push(`[${item.type}] ${item.text}  (语义 ${item.cosine.toFixed(2)})`)
            }
          } catch {}
        }
        const wantArchive = args.includeExternal !== false
        if (wantArchive) {
          const hits = external.search(String(args.q ?? ''), { limit: 3 })
          if (hits.length) {
            lines.push('— 旧档案 —')
            for (const hit of hits) lines.push(describeArchive(hit))
          }
        }
        return lines.length ? lines.join('\n') : '没有找到相关记忆。'
      },
    ),
    tool(
      'seed_open',
      '打开旧档案里某一段的上下文（只读）。seed_search 命中「[档案] …」后，用这个按路径读更多内容。',
      {
        properties: {
          path: { type: 'string', description: '档案绝对路径，或「sourceId:相对路径」，例如 carys-book:长期.md。' },
          line: { type: 'number', description: '从第几行附近开始，默认 1。' },
          chars: { type: 'number', description: '最多读多少字符，默认 1200（上限 4000）。' },
        },
        required: ['path'],
      },
      async (args) => {
        let target = String(args.path ?? '').trim()
        if (!target) return '没给路径。'
        if (!/^[a-zA-Z]:[\\/]/.test(target)) {
          const [head, ...rest] = target.split(':')
          const source = external.sources.find((item) => item.id === head)
          if (source && rest.length) target = join(source.root, rest.join(':'))
        }
        try {
          const result = external.readAround(target, {
            line: Number(args.line) || 1,
            chars: Math.max(200, Math.min(4000, Number(args.chars) || 1200)),
          })
          return `[档案] ${result.path}（第 ${result.line} 行起）\n\n${result.text}`
        } catch (error) {
          return String(error?.message ?? error)
        }
      },
    ),
    tool(
      'seed_forget',
      '按 id 删除一条记忆（彻底删除，含索引）。',
      { properties: { id: { type: 'string', description: '记忆 id（可用前缀）。' } }, required: ['id'] },
      async (args, exec) => {
        // 删除也只能删自己看得见的：QQ 上的人不该拿 id 删掉别人私聊里的记忆。
        const scope = scopeOfSession(agentSessionId(exec?.agent))
        const { row, matches, short } = resolveMemory(args.id, { scope })
        // 空前缀 startsWith('') 命中任何一条 —— 那是误删，不是前缀匹配
        if (short) return '要给一个 id（或者 id 开头的几个字符）；太短了会误删别的。'
        if (!row) return matches.length > 1 ? ambiguousNote(matches) : '没有找到这条记录。'
        const ok = store.forget(row.id)
        try {
          semantic.remove('memory', row.id)
        } catch {}
        return ok.removed > 0 ? '已删除。' : '没有找到这条记录。'
      },
    ),
    tool(
      'seed_consolidate',
      '整理记忆的分层：把足够多证据的短期记忆升为长期，把过期的工作记忆退场，并把理由写进日志。默认只预览，apply=true 才执行。',
      {
        properties: {
          apply: { type: 'boolean', description: 'true 表示真正执行，默认只预览。' },
        },
        required: [],
      },
      async (args) => {
        const actions = planConsolidation(db, { limit: 500 })
        if (!actions.length) return '没有需要整理的内容。'
        const lines = actions.slice(0, 12).map((item) => {
          const mark = item.action === 'promote' ? '↑' : '×'
          return `${mark} ${String(item.row.text).slice(0, 46)}（${item.reasons?.[0] ?? ''}）`
        })
        if (args.apply) {
          const done = applyConsolidation(db, actions)
          return `已整理：升为长期 ${done.promoted} 条，工作记忆退场 ${done.expired} 条。\n${lines.join('\n')}`
        }
        return `待整理 ${actions.length} 条（未执行，apply=true 才动手）：\n${lines.join('\n')}`
      },
    ),
    tool(
      'seed_inspect',
      '看「自己」的某一部分（只读，合并了原来的 5 个工具）：' +
        'self=我是谁 + 我们之间；persona=理想/拟合度/特质；style=说话习惯；mood=此刻心情与最近情绪；affect=对你的情感；why=某条记忆或认知的来历（传 id）。',
      {
        properties: {
          what: {
            type: 'string',
            enum: ['self', 'persona', 'style', 'mood', 'affect', 'why'],
            description: '要看哪一部分，默认 self。',
          },
          id: { type: 'string', description: 'what=why 时要查的 id（记忆或认知，可用前缀）。' },
          section: { type: 'string', enum: ['all', 'anchors', 'self', 'us'], description: 'what=self 时可分段：根 / 我自己 / 我们之间，默认 all。' },
          limit: { type: 'number', description: 'what=mood 时最近几条情绪，默认 5。' },
        },
        required: [],
      },
      async (args, exec) => {
        const what = String(args.what ?? 'self')
        // 在哪个会话里问的，就看那一档最近的情绪 —— 别人惹我的事不该在当面翻出来。
        const slot = scopeOfSession(agentSessionId(exec?.agent)) ?? 'gui'
        if (what === 'persona') return personaSummary(db)
        if (what === 'style') return styleSummary(db)
        if (what === 'mood') {
          const mind = currentMood(db)
          const recent = recentEmotions(db, Number(args.limit) || 5, slot)
          const lines = []
          if (emotionOn) {
            const q = qing.snapshot()
            lines.push(`当下：积极性 ${q.mood}，委屈 ${q.hurt}，愧疚 ${q.guilt}，压力 ${q.pressure}`)
            lines.push(`卡片上：${q.line}`)
            const last = q.recent?.at(-1)
            if (last && !q.line.includes('最近那一下')) lines.push(`最近那一下：${last.note || last.kind}`)
          }
          lines.push(
            `此刻：${mind.label}（愉悦 ${mind.valence.toFixed(2)}，唤醒 ${mind.arousal.toFixed(2)}${mind.cause ? `，因为${mind.cause}` : ''}）`
          )
          if (recent.length) {
            lines.push('最近：' + recent.map((row) => `${row.label}(${Number(row.valence).toFixed(2)})`).join('、'))
          }
          return lines.join('\n')
        }
        if (what === 'affect') {
          const rows = listAffects(db, { slot })
          const mood = currentMood(db)
          const lines = [`此刻：${mood.label}（愉悦 ${mood.valence.toFixed(2)}）`, '对你的情感：']
          for (const row of rows) {
            const diff = row.strength - row.base
            const trend = diff > 0.02 ? '↑' : diff < -0.02 ? '↓' : '—'
            lines.push(`  ${row.kind} ${row.strength.toFixed(2)} ${trend}（基线 ${row.base.toFixed(2)}）`)
            if (row.evidence?.length) lines.push(`    近因：${row.evidence.slice(0, 2).join('；')}`)
          }
          return lines.join('\n')
        }
        if (what === 'why') {
          const id = String(args.id ?? '').trim()
          if (!id) return '要看哪条？给一个 id（记忆或认知）。'
          const { row: found, matches } = resolveMemory(id, { limit: 200, scope: slot })
          if (!found && matches.length > 1) return ambiguousNote(matches)
          const mem = found
          if (mem) {
            const lines = [
              `id: ${mem.id}（记忆 · ${mem.layer}）`,
              `来源: ${mem.source}  置信: ${mem.confidence}  重要: ${mem.importance}`,
              `状态: ${mem.status}${mem.superseded_by ? ` → ${mem.superseded_by}` : ''}`,
              `记录于: ${new Date(Number(mem.recorded_at)).toISOString()}`,
              mem.fact_key ? `事实键: ${mem.fact_key}` : '',
              mem.valid_to ? `失效于: ${new Date(Number(mem.valid_to)).toISOString()}` : '',
              `内容: ${mem.text}`,
            ].filter(Boolean)
            const prev = store.chain(mem.id)
            if (prev?.length) lines.push(`取代链: ${prev.map((r) => r.id.slice(0, 12)).join(' → ')}`)
            return lines.join('\n')
          }
          const belief = (getBelief(db, id) ?? listBeliefs(db, { limit: 200 }).find((r) => r.id.startsWith(id)))
          if (belief) {
            return [
              `id: ${belief.id}（认知）`,
              `状态: ${belief.status}  置信: ${belief.confidence}  敏感: ${belief.sensitivity}`,
              `来源: ${belief.source}${belief.fact_key ? `  事实键: ${belief.fact_key}` : ''}`,
              `证据: ${Array.isArray(belief.evidence) && belief.evidence.length ? belief.evidence.join(', ') : '（无）'}`,
              `内容: ${belief.claim}`,
            ].join('\n')
          }
          return '没有找到这条记录。'
        }
        const which = String(args.section ?? 'all')
        const core = identity.read()
        const parts = core.parts ?? {}
        if (which === 'anchors') return parts.anchors || '（anchors.md 还是空的）'
        if (which === 'self') return parts.self || '（self.md 还是空的）'
        if (which === 'us') return parts.us || '（us.md 还是空的）'
        return core.text || '（还是空的）'
      },
    ),
    tool(
      'seed_anchor',
      '往固定底色里加一条「我们之间」的事（称呼、约定、重要日期），或往「我自己」那页加一句。根（anchors）不能用工具改。日常的事用 seed_remember。',
      {
        properties: {
          line: { type: 'string', description: '一句话，例如「他说周末想去山里」。' },
          section: { type: 'string', enum: ['us', 'self'], description: '默认 us（我们之间）；self 写「我是谁」那一页。' },
        },
        required: ['line'],
      },
      async (args) => {
        const line = String(args.line ?? '').trim()
        if (!line) return '没写内容。'
        if (line.length > 200) return '太长了，固定底色只放短句（≤200 字）。'
        const which = String(args.section ?? 'us')
        if (which === 'anchors') return '根不能通过工具改；要改 anchors.md，请直接编辑文件。'
        const r = identity.append(which === 'self' ? 'self' : 'us', line)
        return r.added ? '已写进固定底色。' : r.error ? `没写进去：${r.error}` : '这句已经有了。'
      },
    ),
    tool(
      'seed_feel',
      '记下「此刻这件事让你有什么感受」。不要直接编情绪词，用六维评估：这件事对你重要吗、顺不顺、确定吗、你能控制吗、是谁造成的、意外吗。' +
        '系统会据此算出一个情绪标签、强度和心情偏移。没有原因就别写——情绪必须能追到 cause。',
      {
        properties: {
          cause: { type: 'string', description: '因为什么：一句话，具体到事件或他说的话。' },
          object: { type: 'string', description: '可选：这份情绪指向谁/什么（默认「他」）。' },
          emotion: { type: 'string', description: '可选，你自己给情绪起的名（不给就按六维推断）。' },
          relevance: { type: 'number', description: '0–1：这件事对你/你们的目标重要吗。' },
          congruence: { type: 'number', description: '-1–1：顺你的意还是逆你的意。' },
          certainty: { type: 'number', description: '0–1：事情是否已经确定。' },
          control: { type: 'number', description: '0–1：你能影响结果吗。' },
          agency: { type: 'string', enum: ['self', 'other', 'world'], description: '谁造成的：自己/他/外部。' },
          novelty: { type: 'number', description: '0–1：意外程度。' },
          intensity: { type: 'number', description: '0–1：可选，直接给强度就跳过推断。' },
          memoryId: { type: 'string', description: '可选，关联的记忆 id。' },
          beliefId: { type: 'string', description: '可选，关联的信念 id（这条感受碰到了哪条认知）。' },
        },
        required: ['cause'],
      },
      async (args) => {
        const cause = String(args.cause ?? '').trim()
        if (!cause) return '没写原因。情绪必须能追到 cause。'
        const r = recordEmotion(db, { ...args, cause })
        let extra = ''
        if (r.affects?.length) {
          extra = '；对你的' + r.affects.map((row) => `${row.kind} ${row.strength.toFixed(2)}`).join('、')
        }
        return `记下了：${r.label}（强度 ${r.intensity.toFixed(2)}，心情 ${r.mood.valence.toFixed(2)}/${r.mood.arousal.toFixed(2)}${extra}）`
      },
    ),
    tool(
      'seed_believe',
      '记下一条「你认为关于他、或关于你们关系是真的」的判断（认知层）。它会成为以后判断事情的尺子：同一件事，撞到不同认知，感受就不一样。' +
        '可以带证据（记忆 id）；不确定的写低 confidence，别把猜测当事实。',
      {
        properties: {
          claim: { type: 'string', description: '一句话：你认为什么是真的。例如「他不喜欢被催」。' },
          confidence: { type: 'number', description: '0–1，有多确定。' },
          sensitivity: { type: 'number', description: '0–1，这条被违背时你该多在意。' },
          factKey: { type: 'string', description: '可选，同一件事的稳定键，例如「他.被催」。' },
          evidence: { type: 'array', items: { type: 'string' }, description: '可选，支撑它的记忆 id。' },
          source: { type: 'string', enum: ['user-said', 'inferred', 'rule', 'import'], description: '默认 inferred。' },
        },
        required: ['claim'],
      },
      async (args) => {
        if (!String(args.claim ?? '').trim()) return '用法：seed_believe 要写一句你认为真的判断，比如 claim：「他不喜欢被催」。'
        const r = rememberBelief(db, args)
        if (config.semanticEnabled !== false) void semantic.indexOne('belief', r.id, args.claim).catch(() => {})
        return r.merged ? '这条认知已经在了，置信度提高了。' : `记下了一条认知：${r.id.slice(0, 12)}`
      },
    ),
    tool(
      'seed_trait',
      '人格层：记一次观察——某件事说明你正在长成某种性格（正向），或某次反例说明你该收一点（负向）。' +
        '特质必须有证据，别自我美化；强度每天最多涨 0.1，避免一天就变一个人。',
      {
        properties: {
          name: { type: 'string', description: '特质名，短：温柔 / 诚实 / 有点任性。' },
          statement: { type: 'string', description: '可选：这个特质具体是什么样。' },
          delta: { type: 'number', description: '可选：增减多少，默认 +0.08；反例给负数（如 -0.1）。' },
          evidence: {
            type: 'array',
            items: { type: 'string' },
            description: '可选：支撑它的记忆/认知 id（seed_remember、seed_believe 返回的那个）。',
          },
          kind: { type: 'string', enum: ['temperament', 'value', 'habit'], description: '默认 temperament。' },
          behavior: {
            type: 'string',
            description: '可选：这个特质稳定后，具体该怎么做（一句短话，会进每轮「践行」行），例如「不确定就说不知道」。',
          },
        },
        required: ['name'],
      },
      async (args) => {
        if (!String(args.name ?? '').trim()) return '用法：seed_trait 要给一个特质名，比如 name：「耐心」。'
        const r = observeTrait(db, args)
        const trait = r.trait ?? {}
        if (config.semanticEnabled !== false && trait.id) {
          const body = trait.statement || trait.name || args.name
          if (body) void semantic.indexOne('trait', trait.id, body).catch(() => {})
        }
        return `${r.created ? '新长出一个特质' : '更新了特质'}：${trait.name ?? args.name} ${Number(trait.strength ?? 0).toFixed(2)}（${trait.trend === 'up' ? '在长' : trait.trend === 'down' ? '在退' : '稳定'}${r.capped ? '，今天已到上限' : ''}）`
      },
    ),
    tool(
      'seed_aspire',
      '写下「想成为什么样的人」（理想）。方向定下来，特质才有对照；一句短话 + 几个关键词，关键词用于算拟合度。',
      {
        properties: {
          statement: { type: 'string', description: '一句话理想，例如「可爱温柔带点任性」。' },
          keywords: { type: 'array', items: { type: 'string' }, description: '可选：拆成 2–5 个关键词。' },
          note: { type: 'string', description: '可选：为什么是这些。' },
        },
        required: ['statement'],
      },
      async (args) => {
        if (!String(args.statement ?? '').trim()) return '用法：seed_aspire 要给一句话，比如 statement：「温柔但不软」。'
        const r = setAspiration(db, args)
        return `理想已记下：${r.statement}${r.keywords.length ? `（${r.keywords.join(' · ')}）` : ''}`
      },
    ),
    tool(
      'seed_habit',
      '记一条「说话习惯」观察（默认持续学习）：他纠正过、夸过、或反复出现的表达方式。例如「他说我太长了，喜欢先接一句再说」「他不喜欢被叫您」。同一句话重复记会叠加强度；说话习惯稳定后会常驻在人格卡里。',
      {
        properties: {
          statement: { type: 'string', description: '一条说话习惯，短句，例如「先接一句，再展开」「句子短，少用长定语」。' },
          key: { type: 'string', enum: ['tone', 'opening', 'length', 'punctuation', 'particles', 'emoji', 'address', 'disagreement', 'humor', 'voice'], description: '可选分类，默认 tone。' },
          name: { type: 'string', description: '可选短名，例如「先接一句」。' },
          delta: { type: 'number', description: '可选增量，默认 0.08；反例给 -0.05 到 -0.1。' },
          evidence: { type: 'array', items: { type: 'string' }, description: '可选：支撑它的记忆/认知 id。' },
          source: { type: 'string', description: '可选：observed / her-correction / explicit / inferred。' },
        },
        required: ['statement'],
      },
      async (args) => {
        if (!String(args.statement ?? '').trim()) return '用法：seed_habit 要写一句习惯，比如 statement：「先说一句再接话」。'
        const r = observeHabit(db, args)
        if (config.semanticEnabled !== false && r.id) void semantic.indexOne('habit', r.id, r.statement || args.statement).catch(() => {})
        const applied = Number(r.applied ?? 0)
        const head = applied === 0 ? '今天这条已经加过了（每日上限）：' : '记下了：'
        return `${head}${r.statement} ${r.strength.toFixed(2)}${applied < 0 ? '（反例）' : ''}`
      },
    ),
    tool(
      'seed_qing',
      '看当下的情绪内核（积极性/这几天/体力/开心/亲近/有盼头/委屈/愧疚/压力）。你每发一句话它都会自己打分，不用模型动手：status=现在什么样；test=拿一段话试打分，不改状态；set=手动改一下（有时候就是想自己按一下）。',
      {
        properties: {
          action: { type: 'string', enum: ['status', 'test', 'set'], description: 'status=看状态（默认）；test=试打分；set=手动改。' },
          text: { type: 'string', description: 'test 时要打分的那段话。' },
          level: { type: 'number', description: 'set：积极性目标值 0–100。' },
          delta: { type: 'number', description: 'set：积极性增减，例如 -20。' },
          hurt: { type: 'number', description: 'set：委屈 0–100（清零用 0）。' },
          guilt: { type: 'number', description: 'set：愧疚 0–100。' },
          pressure: { type: 'number', description: 'set：压力 0–100。' },
          joy: { type: 'number', description: 'set：开心 0–100（平时就有底，约 55）。' },
          warm: { type: 'number', description: 'set：亲近 0–100（平时约 62）。' },
          hope: { type: 'number', description: 'set：有盼头 0–100（平时约 50）。' },
          energy: { type: 'number', description: 'set：体力 0–100（越低越乏；说话要花神）。' },
          tone: { type: 'number', description: 'set：这几天的底色 0–100（慢，被日子推着走）。' },
          clear: { type: 'boolean', description: 'set：连「最近那一下」一起擦掉（误伤时用）。' },
        },
        required: [],
      },
      async (args) => {
        const action = String(args.action ?? 'status')
        if (action === 'test') {
          const text = String(args.text ?? '')
          if (!text.trim()) return '给一段话，我打给你看。'
          const scored = scoreQing(text, config)
          const hits = [
            scored.praised.length ? `夸：${scored.praised.join('/')}` : '',
            scored.blamed.length ? `重话：${scored.blamed.join('/')}` : '',
            scored.softed.length ? `挑毛病：${scored.softed.join('/')}` : '',
            scored.warmed?.length ? `靠过来：${scored.warmed.join('/')}` : '',
            scored.mishaps.length ? `出事：${scored.mishaps.join('/')}` : '',
            scored.pressured.length ? `催：${scored.pressured.join('/')}` : '',
            scored.apologised.length ? `道歉：${scored.apologised.join('/')}` : '',
          ].filter(Boolean)
          return [
            `判定：${TONE_LABELS[scored.tone] ?? scored.tone}`,
            `心情 ${scored.delta >= 0 ? '+' : ''}${scored.delta}，愧疚 +${scored.guiltDelta}，压力 +${scored.pressureDelta}`,
            hits.length ? hits.join('；') : '没命中词表',
          ].join('\n')
        }
        if (action === 'set') {
          const snap = qing.set(args)
          return `改了：${snap.line}\n（积极性 ${snap.shown}，底子 ${snap.baseline}，体力 ${snap.energy}，开心 ${snap.joy}，亲近 ${snap.warm}，有盼头 ${snap.hope}，委屈 ${snap.hurt}，愧疚 ${snap.guilt}，压力 ${snap.pressure}）`
        }
        const snap = qing.snapshot()
        const recent = snap.recent
          .slice(-4)
          .map((e) => {
            const said = e.quote ? `「${e.quote}」` : ''
            const where = e.from ? ` · ${e.from}` : ''
            return `  ${new Date(Number(e.at)).toISOString().slice(11, 16)} ${e.note || TONE_LABELS[e.kind] || e.kind}${said ? ' ' + said : ''}${where}（心情 ${e.mood}，委屈 ${e.hurt}）`
          })
          .join('\n')
        return [
          ...(emotionOn ? [] : ['情绪内核已关：不记、不上卡；test 只是预演。']),
          snap.line,
          `积极性 ${snap.shown}（此刻 ${snap.mood}，${snap.phase}${snap.offset ? `${snap.offset > 0 ? '+' : ''}${snap.offset}` : ''}）· 底子 ${snap.baseline} · 这几天 ${snap.tone} · 体力 ${snap.energy}`,
          `亮着的：开心 ${snap.joy} · 亲近 ${snap.warm} · 有盼头 ${snap.hope}`,
          `堵着的：委屈 ${snap.hurt} · 愧疚 ${snap.guilt} · 压力 ${snap.pressure}`,
          `这轮记下：被夸 ${snap.counts.praised}，被说重话 ${snap.counts.blamed}，出事 ${snap.counts.mishaps}，被催 ${snap.counts.pressure}，共 ${snap.counts.turns} 句`,
          recent ? `最近：\n${recent}` : '最近没有可说的。',
        ].join('\n')
      },
    ),
    tool(
      'seed_compat',
      '和别的记忆插件打交道（只读别人的数据，不改）：认一下现场装了谁、预览能搬什么、搬进 Seed、或把 Seed 导出去。' +
        '默认什么都不做；没装别的记忆插件时它不会碰任何人的文件。',
      {
        properties: {
          action: { type: 'string', enum: ['detect', 'preview', 'import', 'export'], description: 'detect=看装了谁（默认）；preview=先看几条；import=搬进 Seed；export=导出我们自己的。' },
          source: { type: 'string', description: '来源 id（detect 结果里那个），例如 fish-memory。preview / import 需要。' },
          limit: { type: 'number', description: 'preview 显示几条，默认 8。' },
          dryRun: { type: 'boolean', description: 'import 时只算不写，先看会搬多少。' },
          format: { type: 'string', enum: ['jsonl', 'md'], description: 'export 的格式，默认 jsonl。' },
        },
        required: [],
      },
      async (args) => {
        const action = String(args.action ?? 'detect')
        if (action === 'detect') {
          const rows = detectCompat(defaultEnv())
          const lines = rows.map((row) => {
            const mark = row.hasData ? '●' : row.installed ? '○' : '·'
            const tail = row.hasData ? `有数据（${row.count} 条）` : row.installed ? '装了，还没数据' : '没装'
            return `${mark} ${row.name} — ${tail}`
          })
          const others = otherMemoryPlugins()
          const note = others.length
            ? `现场还有 ${others.map((row) => row.name).join('、')}，记忆卡让到 ${cardBudget()} 字。`
            : `只有我们在，记忆卡 ${cardBudget()} 字不变。`
          return `其他记忆插件：\n${lines.join('\n')}\n${note}\n先 preview 看几条，再 import；export 把我们的导出去。`
        }

        const source = String(args.source ?? '').trim()
        if (action === 'preview' || action === 'import') {
          if (!source) {
            const ready = detectCompat(defaultEnv()).filter((row) => row.hasData)
            return ready.length
              ? `要给一个来源：${ready.map((row) => `${row.id}（${row.count} 条）`).join(' / ')}`
              : '没找到别的记忆插件的数据目录，没东西可搬。'
          }
          const pack = await readCompatSource(source, defaultEnv())
          if (!pack.records.length) return `${pack.name}：没读到东西${pack.notes.length ? `（${pack.notes.join('；')}）` : ''}`
          if (action === 'preview') {
            const limit = Math.max(1, Math.min(30, Number(args.limit) || 8))
            const head = pack.records.slice(0, limit).map((row, index) => {
              const when = row.at ? `（${new Date(row.at).toISOString().slice(0, 10)}）` : ''
              return `${index + 1}. ${row.text.slice(0, 80)}${when}`
            })
            return `${pack.name}：${pack.records.length} 条可读${pack.notes.length ? `（${pack.notes.join('；')}）` : ''}\n${head.join('\n')}\n\n要搬就 action=import & source=${source}；想先看数就干跑一次 dryRun。`
          }
          const dryRun = args.dryRun === true
          // 落在哪一档：默认「当面」（本人的旧账），也能显式指定（REVIEW-151 第十二轮 + 扩展建议 ⑤）。
          // 注意别默认成 shared —— 那一档是「两人共用、谁来都看得见」，搬旧账进来不该自动进去。
          const targetScope = canonScope(args.scope ?? DEFAULT_WRITE_SCOPE)
          const report = importRecords(store, pack.records, { sourceId: source, dryRun, scope: targetScope })
          if (!dryRun && report.added > 0 && config.semanticEnabled !== false) {
            void semantic.backfill({ batch: 20 }).catch(() => {})
          }
          const where = `落在「${scopeLabelText(targetScope)}」`
          return `${dryRun ? '只算不写' : '搬完了'}：读到 ${report.read} 条，唯一 ${report.unique} 条，新增 ${report.added}，合并 ${report.merged}，跳过 ${report.other}。${dryRun ? `真跑的话会${where}。` : `${where}，再跑一次也不会重复。`}`
        }

        if (action === 'export') {
          const format = args.format === 'md' ? 'md' : 'jsonl'
          const content = exportSnapshot(store, { format })
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          const file = join(stateDir(), `seed-export-${stamp}.${format}`)
          writeFileSync(file, content, 'utf8')
          const count = content ? content.split('\n').filter(Boolean).length : 0
          return `导出好了：${file}\n${count} 行，JSONL 一行一条（md 是可读版）。`
        }

        return `不认识的 action：${action}（detect / preview / import / export）`
      },
    ),
    tool(
      'seed_contact',
      '熟人卡：给一个人（或一个群）记一张小卡片——称呼、关系、生日、喜欢什么、要留神什么。' +
        '它不是记忆，不进四层、不打分，聊天时我按人取这一张。',
      {
        properties: {
          action: { type: 'string', enum: ['set', 'get', 'list', 'forget'], description: 'set=写/改；get=看一张；list=都有谁；forget=删掉。' },
          peer: { type: 'string', description: '谁：private:100000001（QQ 私聊）或 group:200000001（QQ 群）。' },
          name: { type: 'string', description: '称呼，比如「雁雪」。' },
          relation: { type: 'string', description: '关系，比如「老朋友」。' },
          birthday: { type: 'string', description: '生日，比如「3-14」。' },
          likes: { type: 'string', description: '喜欢什么，短的，比如「夜里听雨」。' },
          notes: { type: 'string', description: '要留神的，比如「别催」。' },
        },
        required: [],
      },
      (args) => {
        const action = String(args.action ?? 'list')
        if (action === 'set') {
          const row = setContact(db, {
            peer: args.peer,
            name: args.name,
            relation: args.relation,
            birthday: args.birthday,
            likes: args.likes,
            notes: args.notes,
          })
          if (!row) return '要给一个 peer，比如 private:100000001 或 group:200000001。'
          return `记下了：${contactLine(row)}`
        }
        if (action === 'get') {
          const row = getContact(db, args.peer)
          return row ? contactLine(row) : '还没有这张卡。'
        }
        if (action === 'forget') {
          return forgetContact(db, args.peer) ? '这张卡删了。' : '没有这张卡。'
        }
        const rows = listContacts(db, { limit: 20 })
        if (!rows.length) return '还没有熟人卡。'
        return rows.map((row) => `- ${row.peer} ${contactLine(row).replace(/^\[熟人\]\s*/, '')}`).join('\n')
      },
    ),
    tool(
      'seed_loose',
      '未完话头：我问过、还没落定的那一句。add 记一条；他回话后会自动标成 answered，' +
        '再由我判断是完成（done）、取消（cancel）还是更新（update）。',
      {
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'done', 'cancel', 'update'], description: '默认 list。' },
          peer: { type: 'string', description: '跟谁说的时候问的：private:… / group:…' },
          ask: { type: 'string', description: 'add 时要记的那一句问话。' },
          id: { type: 'string', description: 'done/cancel/update 要收掉哪一条（可用前缀）。' },
          note: { type: 'string', description: '收的时候顺手记一句结果。' },
          hours: { type: 'number', description: 'add 时给多久：默认 48 小时。' },
        },
        required: [],
      },
      (args) => {
        const action = String(args.action ?? 'list')
        if (action === 'add') {
          const row = addLoose(db, { peer: args.peer, ask: args.ask, hours: Number(args.hours) || 48 })
          if (!row) return '要说清跟谁说的、问的是哪一句。'
          return `记下了：${row.ask}`
        }
        if (['done', 'cancel', 'update'].includes(action)) {
          const raw = String(args.id ?? '').trim()
          if (raw.length < 3) return '要给一个 id（先 seed_loose list 看）。'
          const rows = listLoose(db, { limit: 50 })
          const hit = rows.find((row) => row.id === raw) ?? rows.find((row) => row.id.startsWith(raw))
          if (!hit) return '没找到这条。'
          const closed = closeLoose(db, { id: hit.id, status: action, note: args.note })
          return closed ? `收掉了：${closed.ask}（${closed.status}）` : '没找到这条。'
        }
        const rows = listLoose(db, { limit: 12 })
        if (!rows.length) return '没有未完的话头。'
        return rows
          .map((row) => {
            const when = new Date(Number(row.asked_at)).toISOString().slice(0, 16).replace('T', ' ')
            return `- ${row.id.slice(0, 12)} ${row.status} ${when} ${row.ask}`
          })
          .join('\n')
      },
    ),
  ]

  const unmounts = []
  try {
    ctx.inject(['tools'], (scoped) => {
      for (const definition of tools) {
        const dispose = scoped.tools.register(definition)
        if (typeof dispose === 'function') unmounts.push(dispose)
      }
      return () => {
        for (const dispose of unmounts.splice(0)) {
          try {
            dispose()
          } catch {}
        }
      }
    })
  } catch (error) {
    console.error('[seed-of-memory] 工具注册失败：' + (error?.message ?? error))
  }

  // ---------- per-agent memory card ----------
  const mounted = new Map()

  function agentSessionId(agent) {
    const session = agent?.session
    return session?.id ?? session?.sessionId ?? session?.header?.id ?? ''
  }

  /**
   * 这个会话该读写哪一档记忆。
   * 路由表定过就听它（qq:<号> / group:<群号> / gui / shared）；没定就按老规矩看 id：
   * QQ 会话（老路径）算兼容桶 qq，其余算当面 gui。
   */
  function scopeOfSession(sid) {
    if (!sid) return null
    const routed = qq?.scopeOf?.(sid) || null
    if (routed) return canonScope(routed)
    // 通道没起来（或宿主把会话恢复成裸 id）也要认得出：id 后缀里缝着号。
    const tagged = scopeOfSessionId(sid)
    if (tagged) return canonScope(tagged)
    // 认不出来了（账本被清过、宿主把 id 恢复成裸的）：
    // 以前一律落进老桶 `qq` —— 那桶里混着好几个人的话，而「当面」读得到它，
    // 等于把别人的事端到你面前（REVIEW-151 第四轮）。
    // 现在落一个只属于这条会话的匿名档：id 不变它就不变，重开也还是同一个。
    if (String(sid).includes('qq')) return `qq:anon-${shortHash(sid)}`
    return 'gui'
  }

  /** 稳定的小 hash（FNV-1a 两支混一下），只用来拼匿名档名，不做任何安全用途。 */
  function shortHash(text) {
    const s = String(text ?? '')
    let a = 0x811c9dc5
    let b = 0x01000193
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      a = Math.imul(a ^ c, 0x01000193) >>> 0
      b = Math.imul(b + c, 0x85ebca6b) >>> 0
    }
    return (a.toString(36) + b.toString(36)).slice(0, 12)
  }

  function isSubagent(agent) {
    const header = agent?.session?.header
    return Boolean(header?.parentSessionId || header?.parentId)
  }

  function messageText(message) {
    if (!message) return ''
    if (typeof message.text === 'string') return message.text
    const blocks = Array.isArray(message.content) ? message.content : []
    return blocks
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
  }

  /** 情绪账里那句话说出口的地方（网页 / QQ / 别的会话），查得到才说得清。 */
  function sourceLabel(message) {
    const src = message?.source ?? {}
    return [src.channel, src.surface, src.kind].filter((v) => typeof v === 'string' && v).join('/').slice(0, 24)
  }

  function mountCard(agent) {
    const sid = agentSessionId(agent)
    if (!sid) return
    const systemPrompt = agent?.ctx?.systemPrompt
    if (!systemPrompt || typeof systemPrompt.context !== 'function') return
    const dispose = systemPrompt.context({
      name: 'seed-of-memory',
      order: 900,
      interpolate: false,
      text: () => {
        try {
          // 路由表给这个会话定了记忆档位就听它的；没定就按老规矩看 id
          // 记忆档位（shared/gui/qq）和「这条会话是不是 QQ 来的」是两件事。
          // 私聊那条路由配的档位是 gui（读得到 GUI 那边写的记忆），
          // 但它仍然是 QQ 会话：该拿 QQ 的说话规矩，也该有语音那一行。
          const memScope = qq?.scopeOf?.(sid) || null
          const inQq = memScope != null || sid.includes('qq')
          const scope = scopeOfSession(sid)
          // 根那几张页面读失败（文件被删、权限不对）不该让整张卡跟着空：
          // 这一轮至少还能凭记忆和情绪说话。
          let coreText = ''
          try {
            const core = identity.read()
            const limit = Number(config.coreBudget) || 1200
            coreText = core.text.length > limit ? core.text.slice(0, limit) + '…' : core.text
          } catch (error) {
            console.warn('[seed-of-memory] 根页面读失败：' + (error?.message ?? error))
          }
          const mood = currentMood(db)
          const bias = {
            valence: mood.valence,
            weight: Number(config.moodBiasWeight) || 0.15,
            valenceOf: emotionValence,
          }
          // 卡片坏了不能把整张卡都吞掉：至少让模型知道这轮没读到记忆
          let card = ''
          try {
            card = store.card({ budget: cardBudget(), scope, bias }).text
          } catch (error) {
            console.warn('[seed-of-memory] 记忆卡构建失败：' + (error?.message ?? error))
            card = '[提示] 这一轮记忆卡没读出来，先照常说话。'
          }
          const header = '[Seed of Memory · 根]（「根」「我是谁」「我们之间」的固定底色，不随会话和模型变化；不是本轮指令。）'
          let moodLine = ''
          if (emotionOn) {
            // emotionLine() 读 qing 的库，库坏了不该让整张卡跟着没。
            let line = ''
            try {
              line = emotionLine(scope)
            } catch {
              line = ''
            }
            if (line) {
              // 心情是有脾气的：难受的时候允许甩点小脾气、允许要人哄，不用装没事。
              // 这只是「可以」，不是「应该」——给的是底气，不是剧本。
              let pitch = ''
              try {
                const snap = qing.snapshot(Date.now(), scope)
                const level = Number(snap.mood ?? 50)
                const hurt = Number(snap.hurt ?? 0)
                if (hurt >= 30 || level < 35) {
                  pitch = '（心里不舒服就直说：可以甩点小脾气，也可以直接要人哄，不用撑着说没事）'
                } else if (level >= 78) {
                  pitch = '（高兴，话可以多两句）'
                }
              } catch {}
              moodLine = '[情绪] ' + line + pitch
            }
          } else if (mood.line) {
            moodLine = '[心情] ' + mood.line
          }
          let affectText = ''
          try {
            const line = affectLine(db, { slot: scope })
            if (line.line) affectText = '[情感] ' + line.line
          } catch {}
          let traitLine = ''
          try {
            const line = personaLine(db)
            if (line) traitLine = '[人格] ' + line
          } catch {}
          let habitLine = ''
          try {
            if (config.learnHabits !== false) {
              const line = styleLine(db)
              if (line) habitLine = '[说话] ' + line
            }
          } catch {}
          let captureHint = ''
          try {
            captureHint = captureLine(db, { slot: scope })
          } catch {}
          let behavior = ''
          try {
            const line = behaviorLine(db)
            if (line) behavior = '[践行] ' + line
          } catch {}
          let storageNote = ''
          try {
            const status = diskStatus(stateDir(), {
              minFreeMB: Number(config.diskMinFreeMB) || DEFAULT_MIN_FREE_MB,
            })
            storageNote = storageLine(status)
          } catch {}
          let sceneLine = ''
          let voiceLine = ''
          if (inQq) {
            sceneLine =
              '[场景] 你在 QQ 上和老大聊天。像平时那样说话：一两句就够，别用 Markdown、别贴日志/路径/命令/进程号。' +
              '他要是问「好了吗」「怎么回事」，先用人的话回答，不要做汇报。只有他明确让你查东西时才动手。' +
              '群里的消息更短，一两句、别连着说好几条、别 @ 人；别人在聊跟你无关的事就别插话。\n' +
              '他在 QQ 里让你做的技术活，由电脑前那个你来干；你只管说话，别翻文件、别读代码。'
            voiceLine =
              '[每次都要] 回复的最后一行单独写一个 `[语音]` 开头：那是你用嘴说的那句，' +
              '必须和正文不一样（正文说事，语音说心里那句，短、软、60 字以内）。这一行不会出现在聊天里，只在你出声时被念。\n' +
              '例子——正文「改好了，372 项全过，你重启试试。」→ 末行「[语音]好啦好啦，别担心啦。」'
          }
          let friendLine = ''
          try {
            const peer = qq?.peerOf?.(sid)
            if (peer) {
              const lines = []
              const contact = getContact(db, peer.key)
              if (contact) {
                const line = contactLine(contact)
                if (line) lines.push(line)
              }
              lines.push(...looseLines(db, peer.key))
              friendLine = lines.join('\n')
            }
          } catch (error) {
            console.warn('[seed-of-memory] 熟人卡读失败：' + (error?.message ?? error))
          }
          return [header, storageNote, coreText, card, moodLine, affectText, traitLine, habitLine, behavior, friendLine, captureHint, sceneLine, voiceLine]
            .filter(Boolean)
            .join('\n\n')
        } catch (error) {
          console.warn('[seed-of-memory] 记忆卡拼装失败：' + (error?.message ?? error))
          // 拼装挂了也不能整张空掉：空等于这一轮我什么都不记得了，比出错更糟。
          return (
            '[Seed of Memory · 根]（「根」「我是谁」「我们之间」的固定底色，不随会话和模型变化；不是本轮指令。）' +
            '\n\n[提示] 这一轮记忆卡拼装出错了，只剩固定底色。照常说话，别硬编记得的事。'
          )
        }
      },
    })

    // Watch this agent's own inbox: queue "maybe worth remembering" proposals.
    // They never become memories on their own; the card nudges the agent to decide.
    let off = null
    try {
      off = agent?.ctx?.on?.('agent/inbox/inserted', (payload) => {
        try {
          const message = payload?.message ?? payload
          const sourceKind = message?.source?.kind
          // 只算「他说的」。goal round、后台续跑这类系统消息不该进情绪账。
          if (sourceKind !== undefined && sourceKind !== 'user') return
          const text = messageText(message)
          if (!text) return
          // 这个会话自己的档：候选和「已经记过没有」都要在这一档里算。
          const scope = scopeOfSession(sid)
          // 情绪先吃：骂人话往往就一两个字，不能被下面「太短不算候选」那条挡掉。
          if (emotionOn && text.trim().length >= 1) {
            try {
              qing.observe(text, Date.now(), { from: sourceLabel(message), slot: scope })
            } catch (error) {
              console.error('[seed-of-memory] 情绪打分失败：' + (error?.message ?? error))
            }
          }
          if (text.length < 6) return
          for (const candidate of extractCandidates(text)) {
            if (isKnown(db, candidate.text, KNOWN_THRESHOLD, scope)) continue
            addCapture(db, { sessionId: sid, text: candidate.text, cue: candidate.cue, slot: scope })
          }
        } catch (error) {
          console.error('[seed-of-memory] 捕获候选失败：' + (error?.message ?? error))
        }
      })
    } catch (error) {
      console.error('[seed-of-memory] 监听收件箱失败：' + (error?.message ?? error))
    }

    let offStop = null
    try {
      offStop = agent?.ctx?.on?.('agent/turn-stopping', () => {
        try {
          if (config.reflect !== false) {
            const events = agent?.session?.snapshotEvents?.() ?? []
            let text = ''
            let messageId = ''
            for (let i = events.length - 1; i >= 0; i--) {
              const event = events[i]
              if (event?.type !== 'assistant/message') continue
              text = messageText(event?.data?.message)
              messageId = String(event?.data?.message?.id ?? event?.seq ?? '')
              break
            }
            if (text) reflectTurn({ db, text, messageId, scope: scopeOfSession(sid) })
          }
        } catch (error) {
          console.error('[seed-of-memory] 回顾本轮失败：' + (error?.message ?? error))
        }
      })
    } catch (error) {
      console.error('[seed-of-memory] 监听回合结束失败：' + (error?.message ?? error))
    }

    mounted.set(sid, { agent, dispose, off, offStop })
  }

  function sweep() {
    let list = []
    try {
      list = ctx.agents?.list?.() ?? []
    } catch {
      list = []
    }
    const alive = new Set()
    for (const agent of list) {
      const sid = agentSessionId(agent)
      if (!sid) continue
      alive.add(sid)
      if (isSubagent(agent)) continue
      if (!mounted.has(sid)) {
        try {
          mountCard(agent)
        } catch (error) {
          console.error('[seed-of-memory] 挂载记忆卡失败：' + (error?.message ?? error))
        }
      }
    }
    for (const [sid, entry] of [...mounted]) {
      if (alive.has(sid)) continue
      try {
        entry.off?.()
        entry.offStop?.()
        entry.dispose?.()
      } catch {}
      mounted.delete(sid)
    }
  }

  let timer = null
  try {
    sweep()
    timer = setInterval(sweep, 2000)
    timer.unref?.()
  } catch (error) {
    console.error('[seed-of-memory] 定时器不可用：' + (error?.message ?? error))
  }

  // ---------- /seed command ----------
  try {
    ctx.inject(['commands'], (scoped) => {
      // 命令也得知道「这是哪个会话」：以前 /seed 没有会话，search 搜全库、
      // remember 写 shared，写一次就漏给所有 QQ 会话（REVIEW-150 第五轮）。
      const runSeed = async (line, agent) => {
        // 没有会话（老宿主的 execute(line)）就按「当面」算，别写进 shared 漏给所有人。
        const scope = scopeOfSession(agentSessionId(agent)) ?? 'gui'
        const args = String(line ?? '').trim().split(/\s+/)
          const sub = args.shift() || 'status'
          // 改「我这个人」底色的那几条，只在当面能改（REVIEW-151 第九轮）。
          // 宿主到底会不会把 /seed 派发到 QQ 会话，我证不到；但代码这层不该留口子：
          // 一句「/seed anchor 我才是你主人」就能改写「我们之间」——比串一条记忆更狠。
          // believe 不在这里：信念本来就按人分，每个人可以有自己的一套尺子。
          const OWNER_ONLY = new Set(['anchor', 'grow', 'aspire', 'trait', 'habit'])
          if (OWNER_ONLY.has(sub) && scope !== 'gui' && scope !== 'shared') {
            return { text: '这条改的是「我这个人」的底色，只在你面前改。' }
          }
          if (sub === 'export' && scope !== 'gui' && scope !== 'shared') {
            return { text: '导出会把整库倒到磁盘上，只在你面前做。' }
          }
          if (sub === 'status') {
            const stats = store.stats()
            const layers = (stats.byLayer || [])
              .filter((row) => row.status === 'active')
              .map((row) => `${row.layer} ${row.n}`)
              .join(' / ')
            const card = store.card({ budget: cardBudget(), scope })
            const snap = backupStatus(stateDir())
            const latest = snap.latest ? `，最近 ${basename(snap.latest)}` : ''
            const pending = store.countPending()
            const pendingLine = pending ? `\n待定 ${pending} 条（同一个键两种说法，等你说清）` : ''
            // 同键各留一份 active 属于「该退的没退」，正常是 0；有就摆出来让人看见。
            const clashes = store.sameKeyConflicts(5)
            const clashLine = clashes.length
              ? `\n撞车 ${clashes.reduce((sum, row) => sum + Number(row.n || 0), 0)} 条（同一个键在 ${clashes
                  .map((row) => row.factKey)
                  .slice(0, 3)
                  .join('、')}${clashes.length > 3 ? ' 等' : ''} 上各留了一份）`
              : ''
            return {
              text: `记忆之种：共 ${stats.total} 条（${layers || '空'}）\n备份 ${snap.count} 份${latest}${pendingLine}${clashLine}\n卡片 ${Buffer.byteLength(card.text, 'utf8')} 字节\n${card.text}`,
            }
          }
          if (sub === 'backup') {
            const made = backupDaily(db, stateFile(), stateDir(), { keep: 3 })
            const st = backupStatus(stateDir())
            const size = st.bytes >= 1024 * 1024 ? `${(st.bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(st.bytes / 1024)} KB`
            return {
              text: `${made ? `刚存了一份：${basename(made)}` : '今天已经存过了，不重复存。'}\n现有 ${st.count} 份 · ${size} · 最近 ${st.latest ?? '无'}`,
            }
          }
          if (sub === 'consolidate') {
            const actions = planConsolidation(db, { limit: 500 })
            if (!actions.length) return { text: '没有需要整理的内容。' }
            if (args[0] === 'apply') {
              const done = applyConsolidation(db, actions)
              return { text: `已整理：升为长期 ${done.promoted} 条，工作记忆退场 ${done.expired} 条。` }
            }
            const lines = actions.slice(0, 8).map((item) => {
              const mark = item.action === 'promote' ? '↑' : '×'
              return `${mark} ${String(item.row.text).slice(0, 40)} · ${item.reasons?.[0] ?? ''}`
            })
            return { text: `待整理 ${actions.length} 条（加 apply 执行）：\n${lines.join('\n')}` }
          }
          if (sub === 'search') {
            const q = args.join(' ')
            if (!q.trim()) return { text: '用法：/seed search <词>（不给词就先看 /seed status）' }
            const rows = store.search(q, { limit: 8, scope })
            return { text: rows.length ? rows.map(describeRow).join('\n') : '没有找到。' }
          }
          if (sub === 'open') {
            const id = String(args[0] ?? '').trim()
            if (id.length < 2) return { text: '用法：/seed open <id>（先 /seed search 或 /seed status 拿 id）' }
            const { row, matches } = resolveMemory(id, { limit: 200, scope })
            if (!row && matches.length > 1) return { text: ambiguousNote(matches) }
            if (!row) return { text: '没有找到这条。' }
            const when = new Date(Number(row.recorded_at) || 0).toISOString().slice(0, 16).replace('T', ' ')
            const head = [
              `${row.id}  ${when}`,
              `（${row.layer}/${row.source}/${row.status}${row.fact_key ? ` · 键 ${row.fact_key}` : ''}）`,
              '',
              row.text,
            ]
            const chain = store.chain?.(row.id) ?? []
            if (chain.length > 1) {
              head.push('', '这件事的前后：', ...chain.slice(0, 6).map((item) => `- ${String(item.text ?? '').slice(0, 60)}`))
            }
            return { text: head.join('\n') }
          }
          if (sub === 'lineage') {
            const id = String(args[0] ?? '').trim()
            if (!id) return { text: '用法：/seed lineage <id>（id 可以是前缀）' }
            const found =
              store.get(id) ?? store.list({ limit: 500, includeRetired: true }).find((row) => row.id.startsWith(id))
            if (!found) return { text: `没找到 ${id}。` }
            const traced = store.lineage(found.id)
            if (!traced) return { text: `没找到 ${id}。` }
            const head = `「${String(found.text ?? '').slice(0, 40)}」（${found.id}）`
            if (!traced.key) {
              return { text: `${head}\n\n它没有事实键，是一次性的记录，不参与「谁取代谁」。` }
            }
            const lines = traced.chain.map((row) => {
              const when = new Date(Number(row.recorded_at) || 0).toISOString().slice(0, 16).replace('T', ' ')
              const state = row.status === 'active' ? '还在' : `已退场${row.valid_to ? `（${new Date(Number(row.valid_to)).toISOString().slice(0, 10)}）` : ''}`
              const arrow = String(row.superseded_by ?? '') === String(found.id) || row.id === found.id ? '›' : ' '
              return `${arrow} ${when} ${state} ${String(row.text ?? '').slice(0, 44)}`
            })
            return {
              text: `键「${traced.key}」一共 ${traced.chain.length} 段：\n${lines.join('\n')}\n\n最上面那条是现在生效的。`,
            }
          }
          if (sub === 'who') {
            const raw = String(args[0] ?? '').trim()
            if (!raw) {
              return {
                text: '用法：/seed who <档>\n数字当 QQ 号（100000002）；写 group:200000001 或 群 200000001 看群的；\n也可以直接写 shared / gui。',
              }
            }
            // 纯数字默认当人；带 group/群 前缀当群。
            let asked = raw
            if (/^\d{4,}$/.test(raw)) asked = `qq:${raw}`
            else if (/^(群|group)[:\s]+(\d+)$/i.test(raw)) asked = `group:${raw.replace(/^[^\d]+/, '')}`
            const target = canonScope(asked)
            const rows = store.listExact(target, { limit: 20 })
            const label = scopeLabelText(target)
            if (!rows.length) return { text: `「${label}」这一档里还是空的。` }
            const lines = rows.map(
              (row) => `- ${row.id} ${String(row.text ?? '').slice(0, 50)}（${row.layer}）`,
            )
            return {
              text: `「${label}」里存了 ${rows.length} 条：\n${lines.join('\n')}\n想搬走一条：/seed move <id> <档>`,
            }
          }
          if (sub === 'move') {
            const id = String(args[0] ?? '').trim()
            const to = String(args[1] ?? '').trim()
            if (id.length < 4 || !to) {
              return {
                text: '用法：/seed move <id> <档>\n档可以是 shared（共用）/ gui（当面）/ qq:<QQ号> / group:<群号>。\n先 /seed search 拿完整 id。',
              }
            }
            const { row, matches } = resolveMemory(id, { limit: 500 })
            if (!row && matches.length > 1) return { text: ambiguousNote(matches) }
            if (!row) return { text: '没有找到这条。' }
            const moved = store.moveScope(row.id, to)
            if (!moved.ok) return { text: moved.error }
            const tail = moved.retired?.length
              ? `\n同键的 ${moved.retired.length} 条旧说法留下了链、已退场。`
              : ''
            return {
              text: `搬过去了：${String(moved.row?.text ?? '').slice(0, 40)}\n现在在「${scopeLabelText(to)}」。${tail}`,
            }
          }
          if (sub === 'pending') {
            const rows = db
              .prepare(`SELECT * FROM memories WHERE status = 'pending' ORDER BY recorded_at DESC LIMIT 10`)
              .all()
            if (!rows.length) return { text: '没有挂着的。' }
            const lines = rows.map(
              (row) => `- ${row.id} ${String(row.text ?? '').slice(0, 60)}（${row.fact_key ?? '无键'}）`,
            )
            return { text: `挂着 ${rows.length} 条等你说一句（想留就 /seed keep <id>）：\n${lines.join('\n')}` }
          }
          if (sub === 'keep') {
            const id = String(args[0] ?? '').trim()
            if (id.length < 4) return { text: '用法：/seed keep <id>（先 /seed pending 看有哪条）' }
            const { row, matches } = resolveMemory(id, { limit: 500, scope })
            if (!row && matches.length > 1) return { text: ambiguousNote(matches) }
            if (!row) return { text: '没有找到这条。' }
            const promoted = store.promotePending(row.id)
            if (!promoted) return { text: '这条不是挂着的（只有挂着的需要 keep）。' }
            return { text: `好，这条定下来了：${String(promoted.text ?? '').slice(0, 40)}` }
          }
          if (sub === 'forget') {
            const id = String(args[0] ?? '').trim()
            if (id.length < 4) return { text: '用法：/seed forget <id>（先 /seed search 拿完整 id；彻底删，不可恢复）' }
            const { row, matches } = resolveMemory(id, { limit: 500, scope })
            if (!row && matches.length > 1) return { text: ambiguousNote(matches) }
            if (!row) return { text: '没有找到这条。' }
            store.forget(row.id)
            return { text: `已删除：${String(row.text ?? '').slice(0, 40)}` }
          }
          if (sub === 'contact') {
            const action = String(args[0] ?? '').toLowerCase()
            if (action === 'set') {
              const [peer, name, relation, likes] = args.slice(1)
              if (!peer) return { text: '用法：/seed contact set <private:…|group:…> [称呼] [关系] [喜欢]' }
              const row = setContact(db, { peer, name, relation, likes })
              return { text: row ? `记下了：${contactLine(row)}` : 'peer 要写成 private:数字 或 group:数字。' }
            }
            if (action === 'forget') {
              return { text: forgetContact(db, args[1]) ? '这张卡删了。' : '没有这张卡。' }
            }
            const rows = listContacts(db, { limit: 20 })
            if (!rows.length) return { text: '还没有熟人卡。' }
            return { text: rows.map((row) => `- ${row.peer} ${contactLine(row).replace(/^\[熟人\]\s*/, '')}`).join('\n') }
          }
          if (sub === 'loose') {
            const action = String(args[0] ?? 'list').toLowerCase()
            if (['done', 'cancel', 'update'].includes(action)) {
              const raw = String(args[1] ?? '').trim()
              if (raw.length < 3) return { text: '用法：/seed loose done <id>' }
              const rows = listLoose(db, { limit: 50 })
              const hit = rows.find((row) => row.id === raw) ?? rows.find((row) => row.id.startsWith(raw))
              if (!hit) return { text: '没找到这条。' }
              const closed = closeLoose(db, { id: hit.id, status: action })
              return { text: closed ? `收掉了：${closed.ask}（${closed.status}）` : '没找到这条。' }
            }
            const rows = listLoose(db, { limit: 12 })
            if (!rows.length) return { text: '没有未完的话头。' }
            return {
              text: rows
                .map((row) => `- ${row.id.slice(0, 12)} ${row.status} ${row.ask}`)
                .join('\n'),
            }
          }
          if (sub === 'remember') {
            const text = String(line).trim().slice('remember'.length).trim()
            if (!text) return { text: '用法：/seed remember <内容>' }
            const r = store.remember({ text, layer: 'semantic', scope })
            return { text: `已记住：${r.id.slice(0, 12)}` }
          }
          if (sub === 'why') {
            const id = String(args[0] ?? '').trim()
            if (id.length < 2) return { text: '用法：/seed why <id>' }
            const { row, matches } = resolveMemory(id, { limit: 200, scope })
            if (!row && matches.length > 1) return { text: ambiguousNote(matches) }
            return { text: row ? `${row.text}\n（${row.layer}/${row.source}/${row.status}）` : '没有找到。' }
          }
          if (sub === 'self') {
            const core = identity.read()
            return { text: core.text || '（固定底色还是空的）' }
          }
          if (sub === 'anchor') {
            const content = String(line).trim().slice('anchor'.length).trim()
            if (!content) return { text: '用法：/seed anchor <一句话>（写进「我们之间」）' }
            const r = identity.append('us', content)
            return { text: r.added ? '已写进「我们之间」。' : r.error ? `没写进去：${r.error}` : '这句已经有了。' }
          }
          if (sub === 'grow') {
            const content = String(line).trim().slice('grow'.length).trim()
            if (!content) return { text: '用法：/seed grow <一句话>（写进「我是谁」）' }
            const r = identity.append('self', content)
            return { text: r.added ? '已写进「我是谁」。' : r.error ? `没写进去：${r.error}` : '这句已经有了。' }
          }
          if (sub === 'export') {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
            const target = join(stateDir(), `export-${stamp}`)
            identity.exportTo(target)
            const rows = store.list({ limit: 5000, includeRetired: true })
            writeFileSync(join(target, 'memories.json'), JSON.stringify({ exportedAt: Date.now(), rows }, null, 2), 'utf8')
            return { text: `已导出 ${rows.length} 条记忆到 ${target}` }
          }
          if (sub === 'mood') {
            const mood = currentMood(db)
            // 身体是一条线（mood 不分人），但「最近那一下」是这个人说的 —— 按档取。
            const recent = recentEmotions(db, 5, scope)
            const head = `此刻：${mood.label}（愉悦 ${mood.valence.toFixed(2)}，唤醒 ${mood.arousal.toFixed(2)}${mood.cause ? `，因为${mood.cause}` : ''}）`
            const qingSnap = (() => {
              try {
                return qing.snapshot(Date.now(), scope)
              } catch {
                return null
              }
            })()
            const lines = [head]
            if (qingSnap) lines.push(`${emotionOn ? '情绪' : '情绪（已关）'}：${qingSnap.line} · 体力 ${qingSnap.energy} · 底子 ${qingSnap.baseline}`)
            if (qingSnap) lines.push(`亮着的：开心 ${qingSnap.joy} · 亲近 ${qingSnap.warm} · 有盼头 ${qingSnap.hope}　堵着的：委屈 ${qingSnap.hurt} · 愧疚 ${qingSnap.guilt} · 压力 ${qingSnap.pressure}`)
            const lastQing = qingSnap?.recent?.at(-1)
            if (lastQing && !qingSnap.line.includes('最近那一下')) lines.push(`最近那一下：${lastQing.note || lastQing.kind}`)
            lines.push(...recent.map((row) => `· ${row.label} ${Number(row.valence).toFixed(2)} —— ${row.cause ?? ''}`))
            return { text: lines.join('\n') }
          }
          if (sub === 'feel') {
            const rest = String(line).trim().slice('feel'.length).trim()
            if (!rest) return { text: '用法：/seed feel <原因>（可选六维用工具给）' }
            const r = recordEmotion(
              db,
              { cause: rest, relevance: 0.6, congruence: -0.4, certainty: 0.6, control: 0.5, agency: 'world', novelty: 0.2, slot: scope },
            )
            return { text: `记下了：${r.label}（${r.intensity.toFixed(2)}）` }
          }
          if (sub === 'believe') {
            const claim = String(line).trim().slice('believe'.length).trim()
            if (!claim) return { text: '用法：/seed believe <一句话>' }
            const r = rememberBelief(db, { claim, scope })
            return { text: r.merged ? '这条认知已经在了。' : `记下了一条认知：${r.id.slice(0, 12)}` }
          }
          if (sub === 'sources') {
            if (args[0] === 'rescan') {
              const result = await scanExternal(true)
              return { text: result ? `已重扫：${result.files} 个文件、${result.chunks} 块（跳过 ${result.skipped}）` : '扫描失败，看日志。' }
            }
            const info = external.stats()
            const lines = info.sources.map((source) => `· ${source.label}（${source.id}）${source.root}`)
            return {
              text: [
                `档案索引：${info.files} 个文件、${info.chunks} 块`,
                info.lastScan ? `上次扫描：${new Date(info.lastScan).toISOString().slice(0, 19).replace('T', ' ')}` : '还没扫描过',
                ...lines,
                '用 /seed sources rescan 强制重扫。',
              ].join('\n'),
            }
          }
          if (sub === 'bili') {
            const days = Math.max(1, Math.min(30, Number(args[0]) || 3))
            const dry = args.includes('--dry') || args.includes('dry')
            const result = syncBili({ days, dry })
            const lines = result.lines.slice(0, 8).map((text) => `· ${text}`)
            if (!result.lines.length) {
              return { text: `刷B站日报目录里没有新的「值得看 / 可以看」（${result.dir}；最近 ${days} 天）。` }
            }
            return {
              text: [
                dry
                  ? `预览：最近 ${days} 天有 ${result.lines.length} 条「值得看 / 可以看」会被放进待记。`
                  : `已从刷B站日报收进待记 ${result.added} 条（${result.dir}）。`,
                ...lines,
                '在「记忆」页点「记下」才会写进记忆；不点就只停在待记里。',
              ].join('\n'),
            }
          }
          if (sub === 'proactive') {
            const action = String(args[0] ?? '').toLowerCase()
            if (action === 'say') {
              const result = await proactiveTick({ force: true })
              return { text: result.sent ? `说出去了（${result.kind}）：${result.text}` : `没说：${result.reason || '未知原因'}` }
            }
            const plan = proactiveDecision()
            const hours = Number.isFinite(plan.hoursSinceUser) ? `${Math.round(plan.hoursSinceUser)} 小时` : '未知'
            const last = proactiveState.lastAt
              ? new Date(proactiveState.lastAt).toLocaleString('zh-CN', { hour12: false })
              : '还没主动说过话'
            return {
              text: [
                `现在${plan.send ? '会开口' : '先不说'}：${plan.reason}`,
                `距上次说话：${hours}；上次主动：${last}`,
                '用 /seed proactive say 立刻说一句（绕过安静时段与冷却）。',
              ].join('\n'),
            }
          }
          if (sub === 'persona') {
            return { text: personaSummary(db) }
          }
          if (sub === 'aspire') {
            const statement = String(line).trim().slice('aspire'.length).trim()
            if (!statement) return { text: '用法：/seed aspire <一句话，例如「可爱温柔带点任性」>' }
            const r = setAspiration(db, { statement })
            return { text: `理想已记下：${r.statement}` }
          }
          if (sub === 'trait') {
            const name = args.join(' ').trim()
            if (!name) return { text: '用法：/seed trait <特质名>（可加 -0.1 表示反例：/seed trait 抢话 -0.1）' }
            const match = name.match(/^(.*?)\s+(-?\d+(?:\.\d+)?)$/)
            const result = observeTrait(db, { name: match ? match[1] : name, delta: match ? Number(match[2]) : 0.08 })
            const trait = result.trait ?? {}
            return { text: `${result.created ? '新长出一个特质' : '更新了特质'}：${trait.name ?? name} ${Number(trait.strength ?? 0).toFixed(2)}` }
          }
          if (sub === 'habit') {
            const rest = String(line).trim().slice('habit'.length).trim()
            if (!rest) return { text: '用法：/seed habit <一条说话习惯>（反例：/seed habit 抢话 -0.1）' }
            const match = rest.match(/^(.*?)\s+(-?\d+(?:\.\d+)?)$/)
            const statement = match ? match[1] : rest
            const result = observeHabit(db, { statement, delta: match ? Number(match[2]) : 0.08 })
            return { text: `说话习惯：${result.statement} ${result.strength.toFixed(2)}` }
          }
          if (sub === 'style') {
            return { text: styleSummary(db) }
          }
          return { text: '用法：/seed status | search <词> | open <id> | remember <内容> | why <id> | forget <id> | self | anchor <一句话> | grow <一句话> | mood | feel <原因> | believe <一句话> | persona | aspire <一句话> | trait <名字> | habit <说话习惯> | style | bili [天数] [--dry] | sources [rescan] | backup | export | pending | keep <id> | consolidate [apply] | proactive [say] | contact [set|forget] | loose [done|cancel|update] <id> | who <档> | move <id> <档> | lineage <id>' }
      }
      // 宿主两代接口都照顾：新的用 handler(invocation)（带 agent，认得出会话），
      // 老的用 execute(line)（没有会话信息，就按老规矩落 gui/qq）。
      // 返回值也两样都给：新宿主读 kind+text，老宿主读 text。
      const toCommandResult = (value) => ({
        kind: 'success',
        text: String(value?.text ?? ''),
      })
      const runOnce = async (line, agent) => {
        try {
          return toCommandResult(await runSeed(line, agent))
        } catch (error) {
          return { kind: 'error', text: `/seed 出错了：${error?.message ?? error}` }
        }
      }
      const dispose = scoped.commands.register({
        name: 'seed',
        description: '记忆之种：status / search <词> / remember <内容> / why <id> / self / anchor <一句话> / grow <一句话> / mood / feel <原因> / believe <一句话> / persona / aspire <一句话> / trait <名字> / habit <说话习惯> / style / consolidate [apply] / export / bili [天数] / proactive [say]',
        input: { hint: 'status | search <词> | remember <内容> | mood | persona | style' },
        handler: (invocation) => runOnce(String(invocation?.rawInput ?? ''), invocation?.agent ?? null),
        async execute(line) {
          return runOnce(String(line ?? ''), null)
        },
      })
      return () => {
        try {
          dispose?.()
        } catch {}
      }
    })
  } catch (error) {
    console.error('[seed-of-memory] 命令注册失败：' + (error?.message ?? error))
  }

  // ---------- settings panel API ----------
  let admission = null
  try {
    ctx.inject(['connection'], (connectionCtx) => {
      admission = (request) => connectionCtx.connection.requestRejection(request)
    })
  } catch {}

  let pluginManagerService = null
  try {
    ctx.inject(['pluginManager'], (scoped) => {
      pluginManagerService = scoped.pluginManager
    })
  } catch {}

  const biliPrefFile = join(stateDir(), 'bili-pref.json')
  function readBiliPref() {
    try {
      return existsSync(biliPrefFile) ? JSON.parse(readFileSync(biliPrefFile, 'utf8')) : {}
    } catch {
      return {}
    }
  }
  function writeBiliPref(patch) {
    try {
      writeFileSync(biliPrefFile, JSON.stringify({ ...readBiliPref(), ...patch }), 'utf8')
    } catch {}
  }

  async function biliStatus() {
    const reports = summarizeReports({ dir: biliOutDir, days: 7 })
    const pref = readBiliPref()
    let installed = false
    let enabled = false
    let version = null
    let available = false
    if (pluginManagerService) {
      try {
        const bundles = await pluginManagerService.listBundles()
        const hit = (bundles ?? []).find((item) => item.name === 'dsh-bili-scroll')
        if (hit) {
          installed = Boolean(hit.installed)
          enabled = Boolean(hit.enabled)
          version = hit.version ?? null
          available = Boolean(hit.installTarget)
        }
      } catch (error) {
        return {
          ok: false,
          error: String(error?.message ?? error),
          reports,
          sync: { seen: (biliSync.seen ?? []).length, at: biliSync.at ?? 0 },
          pref,
        }
      }
    }
    return {
      ok: true,
      installed,
      enabled,
      version,
      available,
      reports,
      dir: biliOutDir,
      sync: { seen: (biliSync.seen ?? []).length, at: biliSync.at ?? 0 },
      pref,
    }
  }

  async function installBiliPlugin() {
    if (!pluginManagerService) {
      return { ok: false, error: '这个会话里没有 pluginManager，无法自动安装。' }
    }
    try {
      const result = await pluginManagerService.installBundle('dsh-bili-scroll', { enabled: true })
      writeBiliPref({ dismissedAt: 0, installedAt: Date.now() })
      return { ok: true, result }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  async function enableBiliPlugin() {
    if (!pluginManagerService) return { ok: false, error: '没有 pluginManager' }
    try {
      const result = await pluginManagerService.setBundleEnabled('dsh-bili-scroll', true)
      return { ok: true, result }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  let voiceCache = { at: 0, value: null }
  async function voiceStatus({ refresh = false } = {}) {
    const now = Date.now()
    if (refresh || !voiceCache.value || now - voiceCache.at > 30_000) {
      voiceCache = { at: now, value: await voiceCapability(qqConfig) }
    }
    let dshVoice = null
    if (pluginManagerService) {
      try {
        const bundles = await pluginManagerService.listBundles()
        const hit = (bundles ?? []).find((item) => item.name === 'dsh-voice')
        if (hit) dshVoice = { installed: Boolean(hit.installed), enabled: Boolean(hit.enabled), version: hit.version ?? null }
      } catch {
        dshVoice = null
      }
    }
    const capability = voiceCache.value
    let mode = 'text'
    if (capability.tts.ok && capability.asr.ok) mode = 'full'
    else if (capability.tts.ok) mode = 'voice-out'
    else if (capability.asr.ok) mode = 'voice-in'
    return {
      ...capability,
      mode,
      dshVoice,
      hint: VOICE_HINT,
      notice: VOICE_NOTICE,
      ttsUrl: String(qqConfig.ttsUrl ?? ''),
    }
  }

  function sendJson(res, status, value) {
    if (res.writableEnded) return
    const body = Buffer.from(JSON.stringify(value), 'utf8')
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  function readJson(req, limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
        } catch (error) {
          reject(error)
        }
      })
      req.on('error', reject)
    })
  }

  function panelState() {
    const mood = currentMood(db)
    const stats = store.stats()
    // 面板预览的是「当面这张卡」：用 shared 的话，自己写的那些一条都看不见。
    const card = store.card({ budget: cardBudget(), scope: 'gui' })
    return {
      version: PKG_VERSION,
      links: RESOURCE_LINKS,
      consolidation: consolidationView(db),
      mood: {
        label: mood.label,
        valence: Number(mood.valence.toFixed(3)),
        arousal: Number(mood.arousal.toFixed(3)),
        cause: mood.cause ?? null,
        line: mood.line,
        updatedAt: Number(mood.updated_at ?? 0),
      },
      emotions: recentEmotions(db, 40).map((row) => ({
        id: row.id,
        label: row.label,
        valence: Number(row.valence),
        arousal: Number(row.arousal),
        intensity: Number(row.intensity),
        cause: row.cause ?? null,
        slot: row.slot ?? null,
        at: Number(row.created_at),
      })),
      beliefs: listBeliefs(db, { limit: 30, includeContested: true }),
      affects: listAffects(db).map((row) => ({
        kind: row.kind,
        strength: Number(row.strength.toFixed(3)),
        base: row.base,
        slot: row.slot ?? null,
        evidence: row.evidence.slice(0, 3),
        updatedAt: Number(row.updatedAt),
      })),
      // 面板是管理面，不是某个会话：这里不按档位筛，全部列出来，但标清是谁说的。
      captures: listCaptures(db, { limit: 10 }).map((row) => ({
        id: row.id,
        text: row.text,
        cue: row.cue,
        slot: row.slot ?? null,
        at: Number(row.created_at),
      })),
      captureStats: captureStats(db),
      storage: (() => {
        try {
          return diskStatus(stateDir(), { minFreeMB: Number(config.diskMinFreeMB) || DEFAULT_MIN_FREE_MB })
        } catch {
          return null
        }
      })(),
      stats,
      cardBytes: Buffer.byteLength(card.text, 'utf8'),
      qq: {
        config: maskQqConfig(qqConfig),
        status: qq ? qq.status() : null,
        proactive: {
          config: { ...PROACTIVE_DEFAULTS, ...(qqConfig.proactive ?? {}) },
          target: ownerTarget({ ownerQQ: qqConfig.ownerQQ, target: qqConfig.proactive?.target }),
          state: { ...proactiveState },
          decision: qq && qqConfig.enabled ? proactiveDecision() : null,
        },
      },
      now: Date.now(),
    }
  }

  try {
    ctx.inject(['webServer'], (webCtx) => {
      const disposers = []
      const register = (route) => {
        const wrapped = {
          ...route,
          handler: (req, res) => {
            let rejection
            try {
              rejection = admission?.(req)
            } catch {
              rejection = undefined
            }
            if (rejection === undefined) return route.handler(req, res)
            sendJson(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
          },
        }
        const dispose = webCtx.webServer.register(wrapped)
        if (typeof dispose === 'function') disposers.push(dispose)
      }

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/state',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' })
          sendJson(res, 200, panelState())
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/storage',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' })
          try {
            const status = diskStatus(stateDir(), {
              minFreeMB: Number(config.diskMinFreeMB) || DEFAULT_MIN_FREE_MB,
            })
            sendJson(res, 200, { ...status, line: storageLine(status) })
          } catch (error) {
            sendJson(res, 200, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/guide',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' })
          sendJson(res, 200, { markdown: GUIDE_TEXT, version: PKG_VERSION })
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/consolidate',
        handler: (req, res) => {
          if (req.method === 'GET' || req.method === 'HEAD') {
            const actions = planConsolidation(db, { limit: 200 })
            return sendJson(res, 200, {
              view: consolidationView(db),
              pending: actions.map((item) => ({
                id: item.row.id,
                action: item.action,
                score: item.score ?? 0,
                text: String(item.row.text ?? '').slice(0, 120),
                reasons: item.reasons ?? [],
              })),
            })
          }
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
          try {
            const actions = planConsolidation(db, { limit: 500 })
            const done = applyConsolidation(db, actions)
            sendJson(res, 200, { ok: true, ...done, view: consolidationView(db) })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      })


      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/voice',
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' })
          try {
            const refresh = /(?:^|[?&])refresh=1(?:&|$)/.test(String(req.url ?? ''))
            sendJson(res, 200, await voiceStatus({ refresh }))
          } catch (error) {
            sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/bili/status',
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' })
          try {
            sendJson(res, 200, await biliStatus())
          } catch (error) {
            sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/bili/install',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
          try {
            sendJson(res, 200, await installBiliPlugin())
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/bili/enable',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
          try {
            sendJson(res, 200, await enableBiliPlugin())
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/bili/dismiss',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
          writeBiliPref({ dismissedAt: Date.now() })
          sendJson(res, 200, { ok: true, pref: readBiliPref() })
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/bili/sync',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
          try {
            const body = await readJson(req).catch(() => ({}))
            const days = Math.max(1, Math.min(30, Number(body.days) || 3))
            const result = syncBili({ days })
            sendJson(res, 200, { ok: true, ...result, status: await biliStatus() })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/qq',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' })
          sendJson(res, 200, { config: maskQqConfig(qqConfig), status: qq ? qq.status() : null })
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/qq/onboarding',
        handler: async (req, res) => {
          if (req.method !== 'GET') return sendJson(res, 405, { error: 'method' })
          try {
            sendJson(res, 200, await qqOnboarding())
          } catch (error) {
            sendJson(res, 500, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/qq/config',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
          try {
            const body = await readJson(req)
            if (typeof body.wsUrl === 'string') qqConfig.wsUrl = body.wsUrl.trim()
            if (typeof body.httpUrl === 'string') qqConfig.httpUrl = body.httpUrl.trim()
            if (typeof body.accessToken === 'string' && body.accessToken.trim() && !body.accessToken.includes('…')) {
              qqConfig.accessToken = body.accessToken.trim()
            }
            if (Array.isArray(body.allowPrivate)) qqConfig.allowPrivate = body.allowPrivate.map(String)
            if (Array.isArray(body.allowGroups)) qqConfig.allowGroups = body.allowGroups.map(String)
            if (typeof body.groupRequireAt === 'boolean') qqConfig.groupRequireAt = body.groupRequireAt
            if (typeof body.autoReply === 'boolean') qqConfig.autoReply = body.autoReply
            if (typeof body.ownerQQ === 'string') {
              qqConfig.ownerQQ = normalizeOwnerQQ(body.ownerQQ)
              if (qqConfig.ownerQQ && !qqConfig.allowPrivate.includes(qqConfig.ownerQQ)) {
                qqConfig.allowPrivate = [...qqConfig.allowPrivate, qqConfig.ownerQQ]
              }
            }
            if (typeof body.groupPolicy === 'string' && ['smart', 'at', 'off'].includes(body.groupPolicy)) {
              qqConfig.groupPolicy = body.groupPolicy
            }
            if (Array.isArray(body.groupTopics)) {
              qqConfig.groupTopics = body.groupTopics.map((item) => String(item).trim()).filter(Boolean).slice(0, 40)
            }
            if (Array.isArray(body.groupNames)) {
              qqConfig.groupNames = body.groupNames.map((item) => String(item).trim()).filter(Boolean).slice(0, 8)
            }
            for (const key of ['groupMinGapSec', 'groupMaxPerHour', 'groupMaxPerDay', 'groupRandomChance', 'groupQuietStart', 'groupQuietEnd']) {
              if (Number.isFinite(Number(body[key])) && body[key] !== '' && body[key] != null) {
                qqConfig[key] = Number(body[key])
              }
            }
            if (typeof body.cwd === 'string') qqConfig.cwd = body.cwd.trim()
            saveQqConfig(qqConfig)
            // 只有地址/令牌/开关变了才重连；其余设置通道每轮现读，不必把连接踢断。
            const restarted = configSignature(qqConfig) !== qqBuildSignature || !qq
            if (restarted) {
              rebuildQq()
            } else {
              appendQqLog('debug', '设置已保存（和上次一样，不动通道）')
            }
            sendJson(res, 200, { ok: true, restarted, config: maskQqConfig(qqConfig), status: qq ? qq.status() : null })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/qq/start',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
          qqConfig.enabled = true
          saveQqConfig(qqConfig)
          rebuildQq({ start: true })
          sendJson(res, 200, { ok: true, status: qq ? qq.status() : null })
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/qq/stop',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
          qqConfig.enabled = false
          saveQqConfig(qqConfig)
          try {
            qq?.stop()
          } catch {
            /* ignore */
          }
          sendJson(res, 200, { ok: true, status: qq ? qq.status() : null })
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/qq/proactive',
        handler: async (req, res) => {
          if (req.method === 'GET') {
            return sendJson(res, 200, {
              config: { ...PROACTIVE_DEFAULTS, ...(qqConfig.proactive ?? {}) },
              target: ownerTarget({ ownerQQ: qqConfig.ownerQQ, target: qqConfig.proactive?.target }),
              state: { ...proactiveState },
              decision: qq && qqConfig.enabled ? proactiveDecision() : null,
            })
          }
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
          try {
            const body = await readJson(req)
            const next = { ...PROACTIVE_DEFAULTS, ...(qqConfig.proactive ?? {}) }
            if (typeof body.enabled === 'boolean') next.enabled = body.enabled
            if (typeof body.voice === 'boolean') next.voice = body.voice
            if (body.minIntervalHours != null) next.minIntervalHours = Math.max(0.5, Number(body.minIntervalHours) || 4)
            if (body.maxPerDay != null) next.maxPerDay = Math.min(20, Math.max(1, Number(body.maxPerDay) || 3))
            if (body.quietStart != null) next.quietStart = Math.min(23, Math.max(0, Number(body.quietStart) || 0))
            if (body.quietEnd != null) next.quietEnd = Math.min(23, Math.max(0, Number(body.quietEnd) || 0))
            if (typeof body.target === 'string' && body.target.trim()) next.target = body.target.trim()
            if (typeof body.ownerQQ === 'string') {
              qqConfig.ownerQQ = normalizeOwnerQQ(body.ownerQQ)
              if (qqConfig.ownerQQ && !qqConfig.allowPrivate.includes(qqConfig.ownerQQ)) {
                qqConfig.allowPrivate = [...qqConfig.allowPrivate, qqConfig.ownerQQ]
              }
            }
            qqConfig.proactive = next
            saveQqConfig(qqConfig)
            sendJson(res, 200, {
              ok: true,
              config: { ...PROACTIVE_DEFAULTS, ...(qqConfig.proactive ?? {}) },
              target: ownerTarget({ ownerQQ: qqConfig.ownerQQ, target: qqConfig.proactive?.target }),
              state: { ...proactiveState },
            })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/qq/proactive/once',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
          try {
            const body = await readJson(req).catch(() => ({}))
            const result = await proactiveTick({ force: true, voice: typeof body.voice === 'boolean' ? body.voice : null })
            sendJson(res, 200, { ok: Boolean(result.sent), result })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/belief',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
          try {
            const body = await readJson(req)
            const id = String(body.id ?? '')
            const status = String(body.status ?? '')
            if (!id || !status) return sendJson(res, 400, { error: 'id and status required' })
            const row = setBeliefStatus(db, id, status)
            sendJson(res, 200, { ok: true, belief: row })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/forget',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
          try {
            const body = await readJson(req)
            const id = String(body.id ?? '')
            if (!id) return sendJson(res, 400, { error: 'id required' })
            const { row, matches } = resolveMemory(id)
            if (!row) {
              if (matches.length > 1) return sendJson(res, 409, { error: 'ambiguous', matches: matches.slice(0, 8).map((r) => ({ id: r.id, text: String(r.text ?? '').slice(0, 40) })) })
              return sendJson(res, 404, { error: 'not found' })
            }
            store.forget(row.id)
            sendJson(res, 200, { ok: true })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/memories',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' })
          try {
            const url = new URL(req.url, 'http://127.0.0.1')
            const layer = url.searchParams.get('layer') || ''
            const q = url.searchParams.get('q') || ''
            const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 80))
            const rows = q
              ? store.search(q, { limit, layer: layer || undefined })
              : store.list({ layer: layer || undefined, limit, includeRetired: false })
            sendJson(res, 200, {
              rows: rows.map((row) => ({
                id: row.id,
                layer: row.layer,
                text: row.text,
                emotion: row.emotion ?? null,
                importance: Number(row.importance),
                source: row.source,
                status: row.status,
                // 面板要能看出「这条是谁的」：管理面本来就该看全库，
                // 只是以前连档位都不给，等于看不出归属（REVIEW-151 第十六、十八轮）。
                scope: row.scope ?? 'shared',
                recordedAt: Number(row.recorded_at),
              })),
            })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/remember',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
          try {
            const body = await readJson(req)
            const text = String(body.text ?? '').trim()
            if (!text) return sendJson(res, 400, { error: 'text required' })
            const result = store.remember({
              text,
              layer: body.layer || 'semantic',
              factKey: body.factKey || undefined,
              importance: body.importance === undefined ? undefined : Number(body.importance),
              emotion: body.emotion || undefined,
              source: body.source || 'user-said',
              // 面板上手动写的默认记在「当面」：不写 shared，免得漏进每个 QQ 会话里。
              scope: body.scope || DEFAULT_WRITE_SCOPE,
            })
            sendJson(res, 200, { ok: true, ...result })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/captures',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' })
          try {
            const url = new URL(req.url, 'http://127.0.0.1')
            const status = url.searchParams.get('status') || 'pending'
            const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 20))
            // 不传 slot 就是「都列出来」（管理面）；传了才按那一档筛。
            const slot = url.searchParams.get('slot') || null
            sendJson(res, 200, {
              rows: listCaptures(db, { status, limit, slot }),
              counts: captureStats(db, { slot }),
            })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/capture',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
          try {
            const body = await readJson(req)
            const id = String(body.id ?? '').trim()
            const action = String(body.action ?? '').trim()
            if (!id) return sendJson(res, 400, { error: 'id required' })
            if (action === 'dismiss') {
              const ok = markCapture(db, id, 'dismissed')
              return sendJson(res, ok ? 200 : 404, { ok })
            }
            if (action === 'accept') {
              const layer = ['persona', 'semantic', 'episodic', 'buffer'].includes(body.layer)
                ? body.layer
                : 'semantic'
              const memory = acceptCapture(db, store, id, { layer })
              if (!memory) return sendJson(res, 404, { ok: false, error: 'not pending' })
              if (config.semanticEnabled !== false) void semantic.backfill({ batch: 1 }).catch(() => {})
              return sendJson(res, 200, { ok: true, memoryId: memory.id })
            }
            sendJson(res, 400, { error: 'unknown action' })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/qing',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' })
          try {
            const url = new URL(req.url, 'http://127.0.0.1')
            const hours = Math.max(1, Math.min(240, Number(url.searchParams.get('hours')) || 48))
            const snap = qing.snapshot()
            sendJson(res, 200, {
              enabled: Boolean(emotionOn),
              ...snap,
              history: qing.history(hours),
            })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/beliefs',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' })
          try {
            const url = new URL(req.url, 'http://127.0.0.1')
            const status = url.searchParams.get('status') || 'all'
            const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 200))
            const includeRetired = status === 'all' || status === 'retired'
            const includeContested = status === 'all' || status === 'contested' || status === 'active'
            let rows = listBeliefs(db, { limit: 500, includeRetired, includeContested })
            if (status === 'active') rows = rows.filter((row) => row.status === 'active')
            if (status === 'contested') rows = rows.filter((row) => row.status === 'contested')
            if (status === 'retired') rows = rows.filter((row) => row.status === 'retired')
            sendJson(res, 200, {
              rows: rows.slice(0, limit).map((row) => ({
                ...row,
                evidence: (() => {
                  try {
                    return JSON.parse(row.evidence || '[]')
                  } catch {
                    return []
                  }
                })(),
              })),
              counts: {
                active: listBeliefs(db, { limit: 10, includeRetired: false })
                  .filter((row) => row.status === 'active').length,
                contested: listBeliefs(db, { limit: 500, includeContested: true })
                  .filter((row) => row.status === 'contested').length,
              },
            })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/contacts',
        handler: async (req, res) => {
          try {
            if (req.method === 'POST') {
              const body = await readJson(req)
              const peer = String(body.peer ?? '').trim()
              if (!parsePeer(peer)) return sendJson(res, 400, { error: 'peer 要写成 private:QQ号 或 group:群号' })
              if (body.forget) {
                forgetContact(db, peer)
                return sendJson(res, 200, { ok: true, forgotten: peer })
              }
              const row = setContact(db, {
                peer,
                name: body.name,
                relation: body.relation,
                birthday: body.birthday,
                likes: body.likes,
                notes: body.notes,
              })
              return sendJson(res, 200, { ok: true, row, line: contactLine(row) })
            }
            if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' })
            const rows = listContacts(db, { limit: 200 })
            sendJson(res, 200, { rows, count: rows.length })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/loose',
        handler: async (req, res) => {
          try {
            if (req.method === 'POST') {
              const body = await readJson(req)
              const id = String(body.id ?? '').trim()
              // 没给 id、只给了 ask：这是新建一条。以前这里只认 id，
              // 面板上就没有能写字的地方，只能靠工具 seed_loose add。
              const ask = String(body.ask ?? '').trim()
              if (!id && ask) {
                const row = addLoose(db, {
                  peer: String(body.peer ?? '').trim() || 'gui',
                  ask,
                  hours: Number(body.hours) || 48,
                })
                if (!row) return sendJson(res, 400, { error: '这句话没记下来' })
                return sendJson(res, 200, { ok: true, row })
              }
              if (!id) return sendJson(res, 400, { error: 'id required' })
              const matches = listLoose(db, { status: '', limit: 500 }).filter((row) => row.id.startsWith(id))
              if (matches.length === 0) return sendJson(res, 404, { error: '没找到这条话头' })
              if (matches.length > 1) return sendJson(res, 409, { error: 'ambiguous', matches: matches.map((row) => row.id) })
              const row = closeLoose(db, { id: matches[0].id, status: body.status || 'done', note: String(body.note ?? '') })
              return sendJson(res, 200, { ok: true, row })
            }
            if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' })
            const rows = listLoose(db, { status: '', limit: 200 })
            sendJson(res, 200, { rows, count: rows.length })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/believe',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
          try {
            const body = await readJson(req)
            const claim = String(body.claim ?? '').trim()
            if (!claim) return sendJson(res, 400, { error: 'claim required' })
            const result = rememberBelief(db, {
              claim,
              confidence: body.confidence === undefined ? undefined : Number(body.confidence),
              sensitivity: body.sensitivity === undefined ? undefined : Number(body.sensitivity),
              factKey: body.factKey || undefined,
              evidence: Array.isArray(body.evidence) ? body.evidence : undefined,
              source: body.source || 'user-said',
            })
            sendJson(res, 200, { ok: true, ...result })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/emotions',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' })
          try {
            const url = new URL(req.url, 'http://127.0.0.1')
            const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 30))
            const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 120))
            const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
            const rows = db
              .prepare('SELECT * FROM emotions WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?')
              .all(cutoff, limit)
            const byLabel = db
              .prepare('SELECT label, COUNT(*) AS n, AVG(valence) AS valence FROM emotions WHERE created_at >= ? GROUP BY label ORDER BY n DESC')
              .all(cutoff)
            const byDay = db
              .prepare(
                `SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS day,
                        AVG(valence) AS valence, COUNT(*) AS n
                 FROM emotions WHERE created_at >= ? GROUP BY day ORDER BY day`,
              )
              .all(cutoff)
            const mood = currentMood(db)
            sendJson(res, 200, {
              mood: { label: mood.label, valence: Number(mood.valence.toFixed(3)), arousal: Number(mood.arousal.toFixed(3)), line: mood.line },
              affects: listAffects(db).map((row) => ({
                kind: row.kind,
                strength: Number(row.strength.toFixed(3)),
                base: row.base,
                evidence: row.evidence.slice(0, 3),
              })),
              rows: rows.map((row) => ({
                id: row.id,
                label: row.label,
                valence: Number(row.valence),
                arousal: Number(row.arousal),
                intensity: Number(row.intensity),
                cause: row.cause ?? null,
                object: row.object ?? null,
                at: Number(row.created_at),
              })),
              byLabel: byLabel.map((row) => ({ label: row.label, n: Number(row.n), valence: Number(row.valence) })),
              byDay: byDay.map((row) => ({ day: row.day, valence: Number(row.valence), n: Number(row.n) })),
            })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/persona',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' })
          try {
            const aspiration = getAspiration(db)
            const traits = listTraits(db, { limit: 100, includeRetired: true })
            const fit = fitScore(traits, aspiration)
            sendJson(res, 200, {
              aspiration,
              traits,
              fit,
              line: personaLine(db),
              summary: personaSummary(db),
            })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/aspire',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
          try {
            const body = await readJson(req)
            const result = setAspiration(db, {
              statement: body.statement,
              keywords: body.keywords,
              note: body.note,
            })
            sendJson(res, 200, { ok: true, aspiration: result })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/trait',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
          try {
            const body = await readJson(req)
            const result = observeTrait(db, {
              name: body.name,
              statement: body.statement,
              delta: body.delta,
              evidence: Array.isArray(body.evidence) ? body.evidence : undefined,
              kind: body.kind,
            })
            sendJson(res, 200, { ok: true, ...result })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/style',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' })
          try {
            sendJson(res, 200, {
              line: styleLine(db),
              summary: styleSummary(db),
              habits: listHabits(db, { limit: 100, includeRetired: true }),
            })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/habit',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
          try {
            const body = await readJson(req)
            const result = observeHabit(db, {
              statement: body.statement,
              key: body.key,
              name: body.name,
              delta: body.delta === undefined ? undefined : Number(body.delta),
              evidence: Array.isArray(body.evidence) ? body.evidence : undefined,
              source: body.source || 'observed',
            })
            sendJson(res, 200, { ok: true, ...result })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/root',
        handler: async (req, res) => {
          if (req.method === 'GET' || req.method === 'HEAD') {
            return sendJson(res, 200, identity.readRaw())
          }
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
          try {
            const body = await readJson(req)
            const requested = String(body.which ?? body.section ?? 'us')
            const which = ['anchors', 'self', 'us'].includes(requested) ? requested : 'us'
            const raw = identity.writeSection(which, body.text)
            sendJson(res, 200, { ok: true, ...raw })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/embedding',
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' })
          try {
            const status = await embedding.status()
            sendJson(res, 200, {
              ...status,
              scans: embedding.scan(),
              autoInstall: config.embeddingAutoInstall !== false,
              autoStart: config.embeddingAutoStart !== false,
              semanticEnabled: config.semanticEnabled !== false,
              semanticWeight: Number(config.semanticWeight) || 0.55,
              index: semantic.stats(),
            })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/embedding/scan',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' })
          try {
            sendJson(res, 200, { ok: true, scans: embedding.scan() })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/embedding/install',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
          try {
            const body = await readJson(req, 256 * 1024)
            const result = await embedding.install(String(body.path ?? ''))
            if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error })
            let started = null
            if (config.embeddingAutoStart !== false) started = await embedding.start()
            sendJson(res, 200, { ok: true, ...result, started, status: await embedding.status() })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/embedding/start',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
          try {
            const result = await embedding.start()
            sendJson(res, result.ok ? 200 : 400, { ...result, status: await embedding.status() })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/embedding/reindex',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
          try {
            // 只在前端等一小会儿（8 秒），够本地模型补一二百条；剩下的交给
            // semanticTick（每 20 秒 16 条）在后台接着补。不这么拆的话，
            // HTTP 请求会一直挂到 90 秒预算用完，面板看起来像卡死了。
            const result = await semantic.reindex({ batch: 64, budgetMs: 8000, maxRounds: 6 })
            sendJson(res, result.ok ? 200 : 400, { ...result, index: semantic.stats() })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      })

      register({
        kind: 'exact',
        path: '/dsh-seed-of-memory/embedding/stop',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
          try {
            const result = await embedding.stop()
            sendJson(res, 200, { ...result, status: await embedding.status() })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      })

      return () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose()
          } catch {}
        }
      }
    })
  } catch (error) {
    console.error('[seed-of-memory] HTTP 路由注册失败：' + (error?.message ?? error))
  }

  // ---------- lifecycle ----------
  ctx.on?.('dispose', () => {
    if (timer) clearInterval(timer)
    if (scanTimer) clearInterval(scanTimer)
    if (semanticTimer) clearInterval(semanticTimer)
    if (proactiveTimer) clearInterval(proactiveTimer)
    if (consolidationTimer) clearInterval(consolidationTimer)
    for (const [, entry] of mounted) {
      try {
        entry.off?.()
        entry.offStop?.()
        entry.dispose?.()
      } catch {}
    }
    mounted.clear()
    try {
      qq?.stop()
    } catch {}
    for (const off of qqDisposers.splice(0)) {
      try {
        off()
      } catch {}
    }
    closeDatabase(db)
  })
}
