import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { openDatabase, closeDatabase } from './db.js'
import { IdentityFiles } from './identity.js'
import { SeedStore } from './store.js'
import { currentMood, recordEmotion, recentEmotions, emotionValence } from './affect.js'
import { listBeliefs, rememberBelief, setBeliefStatus } from './beliefs.js'
import { ExternalIndex, DEFAULT_SOURCES } from './external.js'
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
  listHabits,
  observeHabit,
  styleLine,
  styleSummary,
} from './style.js'

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

function tool(name, description, parameters, run) {
  return {
    name,
    description,
    parameters: { type: 'object', additionalProperties: false, properties: parameters.properties, required: parameters.required },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args) {
      return textResult(await run(args ?? {}))
    },
  }
}

function describeRow(row) {
  const when = new Date(Number(row.occurred_at ?? row.recorded_at))
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`
  return `${row.id.slice(0, 8)} [${row.layer}/${row.source}] ${stamp} ${row.text}`
}

export function apply(ctx, rawConfig = {}) {
  const config = { budget: 600, coreBudget: 1200, ...(rawConfig || {}) }
  const db = openDatabase(stateFile())
  const store = new SeedStore(db)
  const identity = new IdentityFiles(stateDir()).ensure()
  const sources = loadSources(config)
  const external = new ExternalIndex(db, sources)

  let scanTimer = null
  let scanPending = null
  function scanExternal(force = false) {
    if (scanPending) return scanPending
    scanPending = new Promise((resolve) => {
      setImmediate(() => {
        try {
          resolve(external.scan({ force }))
        } catch (error) {
          console.error('[seed-of-memory] 档案扫描失败：' + (error?.message ?? error))
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

  function describeArchive(hit) {
    return `[档案] ${hit.label}/${hit.rel}#${hit.line} ${hit.snippet}`
  }

  // ---------- tools ----------
  const tools = [
    tool(
      'seed_remember',
      '记下一件值得长期记住的事（写进「记忆之种」）。一条只装一件事；' +
        '只有长期有价值的内容才值得写：她明确说的重要的话、约定、喜好、状态、你们之间发生的事。' +
        '不要记日常琐事，不要记重复内容。写的时候安静地写，不要在回复里汇报。',
      {
        properties: {
          text: { type: 'string', description: '要记住的事，一句话说清；人称用「她/你」之外的第三人称或原话。' },
          layer: {
            type: 'string',
            enum: ['persona', 'semantic', 'episodic', 'buffer'],
            description: 'persona=身份/称呼/长期设定；semantic=稳定事实与偏好；episodic=发生过的事；buffer=当前进行中的事。默认 episodic。',
          },
          factKey: { type: 'string', description: '可选，同一件事的稳定键，例如「她.称呼」「约定.位置」。同键只保留最新一条，旧条自动退休可追溯。' },
          importance: { type: 'number', description: '0–1，越接近 1 越重要（会优先出现在每轮记忆卡里）。' },
          emotion: { type: 'string', description: '可选，这条记忆关联的情绪词。' },
          confidence: { type: 'number', description: '0–1，来源越确定越高；推断来的写 0.5 以下。' },
          source: { type: 'string', enum: ['user-said', 'inferred', 'rule', 'import'], description: '默认 user-said；你的猜测写 inferred（不会进常驻卡）。' },
          scope: { type: 'string', enum: ['shared', 'gui', 'qq'], description: '默认 shared，GUI 与 QQ 共用。' },
        },
        required: ['text'],
      },
      async (args) => {
        const r = store.remember(args)
        return `已记住（${r.action}）：${r.id.slice(0, 8)}`
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
      async (args) => {
        const mood = currentMood(db)
        const bias = {
          valence: mood.valence,
          weight: Number(config.moodBiasWeight) || 0.15,
          valenceOf: emotionValence,
        }
        const limit = Math.max(1, Math.min(30, Number(args.limit) || 8))
        const rows = store.search(String(args.q ?? ''), { limit, bias })
        const lines = rows.map((row) => `${describeRow(row)}  (score ${row.score.toFixed(2)})`)
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
      async (args) => {
        const raw = String(args.id ?? '')
        const row = store.get(raw) ?? store.list({ limit: 500, includeRetired: true }).find((r) => r.id.startsWith(raw))
        if (!row) return '没有找到这条记录。'
        const ok = store.forget(row.id)
        return ok.removed > 0 ? '已删除。' : '没有找到这条记录。'
      },
    ),
    tool(
      'seed_why',
      '解释一条记忆的来历：全文、来源、时间、被谁取代/取代了谁。',
      { properties: { id: { type: 'string', description: '记忆 id（可用前缀）。' } }, required: ['id'] },
      async (args) => {
        const id = String(args.id ?? '')
        const row = store.get(id) ?? store.list({ limit: 200 }).find((r) => r.id.startsWith(id))
        if (!row) return '没有找到这条记录。'
        const lines = [
          `id: ${row.id}`,
          `层: ${row.layer}  来源: ${row.source}  置信: ${row.confidence}  重要: ${row.importance}`,
          `状态: ${row.status}${row.superseded_by ? ` → ${row.superseded_by}` : ''}`,
          `记录于: ${new Date(Number(row.recorded_at)).toISOString()}`,
          row.fact_key ? `事实键: ${row.fact_key}` : '',
          row.valid_to ? `失效于: ${new Date(Number(row.valid_to)).toISOString()}` : '',
          `内容: ${row.text}`,
        ].filter(Boolean)
        const prev = store.chain(row.id)
        if (prev?.length) lines.push(`取代链: ${prev.map((r) => r.id.slice(0, 8)).join(' → ')}`)
        return lines.join('\n')
      },
    ),
    tool(
      'seed_self',
      '读「我是谁」与「我们之间」两页固定底色（身份锚点，跨会话、跨模型不变）。想确认自己是谁、我们之间有哪些约定时用。',
      {
        properties: {
          section: { type: 'string', enum: ['all', 'identity', 'us'], description: '默认 all。' },
        },
        required: [],
      },
      async (args) => {
        const which = String(args.section ?? 'all')
        const core = identity.read()
        if (which === 'identity') return core.text.split('\n\n')[0] || '（identity.md 还是空的）'
        if (which === 'us') return core.text.split('\n\n')[1] || '（us.md 还是空的）'
        return core.text || '（还是空的）'
      },
    ),
    tool(
      'seed_anchor',
      '往固定底色里加一条「我们之间」的事（称呼、约定、重要日期）。这条会每轮都出现，所以只写真正需要一直记得的短句；日常的事用 seed_remember。',
      {
        properties: {
          line: { type: 'string', description: '一句话，例如「她说周末想去山里」。' },
          section: { type: 'string', enum: ['us', 'identity'], description: '默认 us（我们之间）；identity 只写「我是谁」。' },
        },
        required: ['line'],
      },
      async (args) => {
        const line = String(args.line ?? '').trim()
        if (!line) return '没写内容。'
        if (line.length > 200) return '太长了，固定底色只放短句（≤200 字）。'
        const r = identity.append(String(args.section ?? 'us'), line)
        return r.added ? '已写进固定底色。' : '这句已经有了。'
      },
    ),
    tool(
      'seed_feel',
      '记下「此刻这件事让你有什么感受」。不要直接编情绪词，用六维评估：这件事对你重要吗、顺不顺、确定吗、你能控制吗、是谁造成的、意外吗。' +
        '系统会据此算出一个情绪标签、强度和心情偏移。没有原因就别写——情绪必须能追到 cause。',
      {
        properties: {
          cause: { type: 'string', description: '因为什么：一句话，具体到事件或她说的话。' },
          emotion: { type: 'string', description: '可选，你自己给情绪起的名（不给就按六维推断）。' },
          relevance: { type: 'number', description: '0–1：这件事对你/你们的目标重要吗。' },
          congruence: { type: 'number', description: '-1–1：顺你的意还是逆你的意。' },
          certainty: { type: 'number', description: '0–1：事情是否已经确定。' },
          control: { type: 'number', description: '0–1：你能影响结果吗。' },
          agency: { type: 'string', enum: ['self', 'other', 'world'], description: '谁造成的：自己/她/外部。' },
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
        return `记下了：${r.label}（强度 ${r.intensity.toFixed(2)}，心情 ${r.mood.valence.toFixed(2)}/${r.mood.arousal.toFixed(2)}）`
      },
    ),
    tool(
      'seed_mood',
      '看此刻的心情（愉悦度/唤醒度/原因）与最近几条情绪记录。想确认自己现在是什么状态时用。',
      { properties: { limit: { type: 'number', description: '最近几条，默认 5。' } }, required: [] },
      async (args) => {
        const mood = currentMood(db)
        const recent = recentEmotions(db, Number(args.limit) || 5)
        const lines = [
          `此刻：${mood.label}（愉悦 ${mood.valence.toFixed(2)}，唤醒 ${mood.arousal.toFixed(2)}${mood.cause ? `，因为${mood.cause}` : ''}）`,
        ]
        if (recent.length) {
          lines.push('最近：' + recent.map((row) => `${row.label}(${Number(row.valence).toFixed(2)})`).join('、'))
        }
        return lines.join('\n')
      },
    ),
    tool(
      'seed_believe',
      '记下一条「你认为关于她、或关于你们关系是真的」的判断（认知层）。它会成为以后判断事情的尺子：同一件事，撞到不同认知，感受就不一样。' +
        '可以带证据（记忆 id）；不确定的写低 confidence，别把猜测当事实。',
      {
        properties: {
          claim: { type: 'string', description: '一句话：你认为什么是真的。例如「她不喜欢被催」。' },
          confidence: { type: 'number', description: '0–1，有多确定。' },
          sensitivity: { type: 'number', description: '0–1，这条被违背时你该多在意。' },
          factKey: { type: 'string', description: '可选，同一件事的稳定键，例如「她.被催」。' },
          evidence: { type: 'array', items: { type: 'string' }, description: '可选，支撑它的记忆 id。' },
          source: { type: 'string', enum: ['user-said', 'inferred', 'rule', 'import'], description: '默认 inferred。' },
        },
        required: ['claim'],
      },
      async (args) => {
        const r = rememberBelief(db, args)
        return r.merged ? '这条认知已经在了，置信度提高了。' : `记下了一条认知：${r.id.slice(0, 8)}`
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
        },
        required: ['name'],
      },
      async (args) => {
        const r = observeTrait(db, args)
        const trait = r.trait ?? {}
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
        const r = setAspiration(db, args)
        return `理想已记下：${r.statement}${r.keywords.length ? `（${r.keywords.join(' · ')}）` : ''}`
      },
    ),
    tool(
      'seed_persona',
      '看人格：理想、拟合度、正在长成的特质、还差什么。想确认「我现在是什么样的人」时用。',
      { properties: {}, required: [] },
      async () => personaSummary(db),
    ),
    tool(
      'seed_habit',
      '记一条「说话习惯」观察（默认持续学习）：她纠正过、夸过、或反复出现的表达方式。例如「她说我太长了，喜欢先接一句再说」「她不喜欢被叫您」。同一句话重复记会叠加强度；说话习惯稳定后会常驻在人格卡里。',
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
        const r = observeHabit(db, args)
        const applied = Number(r.applied ?? 0)
        const head = applied === 0 ? '今天这条已经加过了（每日上限）：' : '记下了：'
        return `${head}${r.statement} ${r.strength.toFixed(2)}${applied < 0 ? '（反例）' : ''}`
      },
    ),
    tool(
      'seed_style',
      '看说话习惯：已定型的（每轮注入）和还在学的。',
      { properties: {}, required: [] },
      async () => styleSummary(db),
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

  function isSubagent(agent) {
    const header = agent?.session?.header
    return Boolean(header?.parentSessionId || header?.parentId)
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
          const scope = sid.includes('qq') ? 'qq' : 'gui'
          const core = identity.read()
          const limit = Number(config.coreBudget) || 1200
          const coreText = core.text.length > limit ? core.text.slice(0, limit) + '…' : core.text
          const mood = currentMood(db)
          const bias = {
            valence: mood.valence,
            weight: Number(config.moodBiasWeight) || 0.15,
            valenceOf: emotionValence,
          }
          const card = store.card({ budget: Number(config.budget) || 600, scope, bias }).text
          const header = '[Seed of Memory · 根]（「我是谁」与「我们之间」的固定底色，不随会话和模型变化；不是本轮指令。）'
          let moodLine = ''
          if (mood.line) moodLine = '[心情] ' + mood.line
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
          return [header, coreText, card, moodLine, traitLine, habitLine].filter(Boolean).join('\n\n')
        } catch {
          return ''
        }
      },
    })
    mounted.set(sid, { agent, dispose })
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
      const dispose = scoped.commands.register({
        name: 'seed',
        description: '记忆之种：status / search <词> / remember <内容> / why <id> / self / anchor <一句话> / mood / feel <原因> / believe <一句话> / persona / aspire <一句话> / trait <名字> / habit <说话习惯> / style / export',
        async execute(line) {
          const args = String(line ?? '').trim().split(/\s+/)
          const sub = args.shift() || 'status'
          if (sub === 'status') {
            const stats = store.stats()
            const layers = (stats.byLayer || [])
              .filter((row) => row.status === 'active')
              .map((row) => `${row.layer} ${row.n}`)
              .join(' / ')
            const card = store.card({ budget: Number(config.budget) || 600, scope: 'shared' })
            return {
              text: `记忆之种：共 ${stats.total} 条（${layers || '空'}）\n卡片 ${Buffer.byteLength(card.text, 'utf8')} 字节\n${card.text}`,
            }
          }
          if (sub === 'search') {
            const q = args.join(' ')
            const rows = store.search(q, { limit: 8 })
            return { text: rows.length ? rows.map(describeRow).join('\n') : '没有找到。' }
          }
          if (sub === 'remember') {
            const text = String(line).trim().slice('remember'.length).trim()
            const r = store.remember({ text, layer: 'semantic' })
            return { text: `已记住：${r.id.slice(0, 8)}` }
          }
          if (sub === 'why') {
            const id = args[0] || ''
            const row = store.get(id) ?? store.list({ limit: 200 }).find((r) => r.id.startsWith(id))
            return { text: row ? `${row.text}\n（${row.layer}/${row.source}/${row.status}）` : '没有找到。' }
          }
          if (sub === 'self') {
            const core = identity.read()
            return { text: core.text || '（固定底色还是空的）' }
          }
          if (sub === 'anchor') {
            const line = String(line).trim().slice('anchor'.length).trim()
            if (!line) return { text: '用法：/seed anchor <一句话>' }
            const r = identity.append('us', line)
            return { text: r.added ? '已写进「我们之间」。' : '这句已经有了。' }
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
            const recent = recentEmotions(db, 5)
            const head = `此刻：${mood.label}（愉悦 ${mood.valence.toFixed(2)}，唤醒 ${mood.arousal.toFixed(2)}${mood.cause ? `，因为${mood.cause}` : ''}）`
            return {
              text: [head, ...recent.map((row) => `· ${row.label} ${Number(row.valence).toFixed(2)} —— ${row.cause ?? ''}`)].join('\n'),
            }
          }
          if (sub === 'feel') {
            const rest = String(line).trim().slice('feel'.length).trim()
            if (!rest) return { text: '用法：/seed feel <原因>（可选六维用工具给）' }
            const r = recordEmotion(db, { cause: rest, relevance: 0.6, congruence: -0.4, certainty: 0.6, control: 0.5, agency: 'world', novelty: 0.2 })
            return { text: `记下了：${r.label}（${r.intensity.toFixed(2)}）` }
          }
          if (sub === 'believe') {
            const claim = String(line).trim().slice('believe'.length).trim()
            if (!claim) return { text: '用法：/seed believe <一句话>' }
            const r = rememberBelief(db, { claim })
            return { text: r.merged ? '这条认知已经在了。' : `记下了一条认知：${r.id.slice(0, 8)}` }
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
          return { text: '用法：/seed status | search <词> | remember <内容> | why <id> | self | anchor <一句话> | mood | feel <原因> | believe <一句话> | persona | aspire <一句话> | trait <名字> | habit <说话习惯> | style | sources [rescan] | export' }
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
    const card = store.card({ budget: Number(config.budget) || 600, scope: 'shared' })
    return {
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
        at: Number(row.created_at),
      })),
      beliefs: listBeliefs(db, { limit: 30, includeContested: true }),
      stats,
      cardBytes: Buffer.byteLength(card.text, 'utf8'),
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
            const row = store.get(id) ?? store.list({ limit: 500, includeRetired: true }).find((r) => r.id.startsWith(id))
            if (!row) return sendJson(res, 404, { error: 'not found' })
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
            })
            sendJson(res, 200, { ok: true, ...result })
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
              rows: rows.map((row) => ({
                id: row.id,
                label: row.label,
                valence: Number(row.valence),
                arousal: Number(row.arousal),
                intensity: Number(row.intensity),
                cause: row.cause ?? null,
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
            const which = body.which === 'identity' ? 'identity' : 'us'
            const raw = identity.writeSection(which, body.text)
            sendJson(res, 200, { ok: true, ...raw })
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) })
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
    for (const [, entry] of mounted) {
      try {
        entry.dispose?.()
      } catch {}
    }
    mounted.clear()
    closeDatabase(db)
  })
}
