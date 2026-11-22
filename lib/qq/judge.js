/**
 * 说之前先判一遍：这句话现在该不该说出口。
 *
 * 2026-11-22 新加的一层（本人：「真正会判断该不该说的那一层，还没长出来」）。
 * 以前是「方案挑中了就发」——挑记忆靠关键词、情绪权重、相似度，
 * 至于「此刻说这件事合不合适」，没有任何一处真正在判断。
 * 现在把判断单独拿出来，两条线：
 *   硬闸——时机不对就别说（安静时段、今天说得够多、刚说不久、这话刚说过、别人的事）；
 *   打分——内容值不值得说（有没有具体的事、是不是陈年旧闻、有没有播报腔、留没留钩子、语气合不合此刻）。
 * 全是纯函数，不碰数据库和网络，方便一条一条测。
 */

import { inQuietHours, isRepeat, localHour } from './proactive.js'

export const JUDGE_DEFAULTS = {
  minScore: 0.58,
  maxChars: 120,
  freshDays: 3,
  staleDays: 14,
}

/** 当引子的记忆是哪一档的：别人的私事不该拿去对老大讲。 */
function seedScopeOk(seedScope, scope) {
  const from = String(seedScope ?? '').trim()
  if (!from) return true
  if (from === 'shared') return true
  const mine = String(scope ?? '').trim()
  if (!mine) return true
  return from === mine
}

/** 「今天有件小事让我挺开心：2026-11-13 …正式发布」——这种播报腔，听着就不像人说话。 */
const BROADCAST = /(今天有件|正式发布|已经发布|已上线|已修复|向您|报告一下|汇报一下|进度是|第\s*\d+\s*步|总结一下|提交了|更新了版本|版本号)/

/** 留了钩子没有：问句，或者把话递回给他。 */
function hasHook(text) {
  return /[？?]\s*$/.test(text) || /(你还好吗|你在干嘛|你呢|你那边|你再说|好不好|在吗)/.test(text)
}

function timeOfDayWord(hour) {
  if (hour >= 5 && hour < 9) return '早上'
  if (hour >= 9 && hour < 12) return '上午'
  if (hour >= 12 && hour < 14) return '中午'
  if (hour >= 14 && hour < 18) return '下午'
  if (hour >= 18 && hour < 23) return '晚上'
  return '深夜'
}

const KIND_BASE = { worry: 0.66, miss: 0.7, lonely: 0.6, glad: 0.65 }
const KIND_ZH = { worry: '有点担心', miss: '想他', lonely: '一个人待着', glad: '想分享' }

/**
 * 判一句话。
 * @param {object} input
 * @param {string} input.text            要说出口的话
 * @param {string} [input.kind]          worry / miss / lonely / glad
 * @param {string} [input.seed]          这句话引用的那条记忆（洗过）
 * @param {number} [input.seedAt]        那条记忆是什么时候记的（毫秒）
 * @param {string} [input.seedScope]     那条记忆在哪个档
 * @param {string} [input.scope]         这一轮说话用的档
 * @param {Array}  [input.recent]        最近说过的话（{at,text}）
 * @param {object} [input.qing]          此刻的情绪内核（{mood, hurt, energy}）
 * @param {object} [input.config]        proactive 配置
 * @param {number} [input.now]
 * @param {number} [input.lastAt]        上次主动开口的时间
 * @param {number} [input.lastUserAt]    他上次说话的时间
 * @param {number} [input.dayCount]      今天已经主动说了几次
 * @returns {{speak: boolean, score: number, reason: string, gates: Array}}
 */
export function judgeUtterance({
  text = '',
  kind = 'miss',
  seed = '',
  seedAt = 0,
  seedScope = '',
  scope = '',
  recent = [],
  qing = {},
  config = {},
  now = Date.now(),
  lastAt = 0,
  lastUserAt = 0,
  dayCount = 0,
  hoursSinceUser = null,
} = {}) {
  const cfg = { ...JUDGE_DEFAULTS, ...(config ?? {}) }
  const say = String(text ?? '').trim()
  const gates = []
  const hard = (id, ok, note) => {
    gates.push({ id, ok: Boolean(ok), hard: true, note })
    return Boolean(ok)
  }
  const soft = (id, value, weight, note) => {
    const v = Math.max(0, Math.min(1, Number(value) || 0))
    gates.push({ id, ok: v >= 0.5, soft: true, value: Number(v.toFixed(2)), weight, note })
  }

  // ——— 硬闸：时机 ———
  if (!hard('content', say.length > 0 && /[\u4e00-\u9fa5]/.test(say), say ? '没有能出口的中文' : '空话不用说')) {
    return finish(false, '没有能出口的话', gates)
  }
  if (!hard('quiet', !inQuietHours(localHour(now), cfg.quietStart ?? 23, cfg.quietEnd ?? 8), '这会儿是他歇着的时候')) {
    return finish(false, '安静时段', gates)
  }
  if (!hard('quota', Number(dayCount) < Number(cfg.maxPerDay ?? 3), '今天已经说得够多了')) {
    return finish(false, '今天说得够多了', gates)
  }
  const minInterval = Math.max(0.5, Number(cfg.minIntervalHours) || 4) * 3_600_000
  if (!hard('interval', !lastAt || now - Number(lastAt) >= minInterval, '刚找过，再等等')) {
    return finish(false, '刚说不久', gates)
  }
  if (!hard('repeat', !isRepeat(say, recent, { now }), '这话刚说过')) {
    return finish(false, '这话刚说过', gates)
  }
  if (!hard('privacy', seedScopeOk(seedScope, scope), '这条是别人档里的事，不该拿来跟他说')) {
    return finish(false, '引子来自别人的档', gates)
  }

  // ——— 打分：值不值得说 ———
  soft('kind', KIND_BASE[kind] ?? 0.6, 0.9, KIND_ZH[kind] ?? '想说话')

  const cleanSeedText = String(seed ?? '').trim()
  soft('seed', cleanSeedText ? 0.78 + (cleanSeedText.length >= 8 ? 0.1 : 0) : 0.5, 0.8, cleanSeedText ? '有具体的事' : '只能说说自己')

  const freshWeight = kind === 'glad' ? 0.8 : 0.3
  let fresh = 0.6
  if (seedAt) {
    const ageDays = Math.max(0, (now - Number(seedAt)) / 86_400_000)
    fresh = ageDays <= cfg.freshDays ? 0.92 : ageDays <= cfg.staleDays ? 0.7 : 0.4
  }
  soft('fresh', fresh, freshWeight, fresh >= 0.9 ? '事还新' : fresh >= 0.6 ? '有几天了' : '陈年旧闻')

  soft('broadcast', BROADCAST.test(say) ? 0.15 : 0.92, 1.1, BROADCAST.test(say) ? '像在播报' : '不像播报')
  soft('hook', hasHook(say) ? 0.9 : 0.62, 0.6, hasHook(say) ? '留了话头' : '全是自己在说')

  const len = say.length
  const lenScore = len > Number(cfg.maxChars) ? 0.45 : len < 6 ? 0.5 : 0.9
  soft('length', lenScore, 0.35, lenScore >= 0.9 ? '长短合适' : len > cfg.maxChars ? '太长' : '太短')

  const mood = Number(qing?.mood)
  let tone = 0.85
  let toneNote = '语气对得上'
  if (kind === 'glad' && Number.isFinite(mood) && mood < 45) {
    tone = 0.3
    toneNote = '自己心里并不轻松，别硬装开心'
  } else if (kind === 'worry' && Number.isFinite(mood) && mood >= 72) {
    tone = 0.4
    toneNote = '心情明明很好，忽然说担心有点假'
  }
  soft('tone', tone, 0.7, toneNote)

  const h = Number.isFinite(Number(hoursSinceUser)) ? Number(hoursSinceUser) : null
  const gap = h == null ? 0.6 : h >= 12 ? 0.95 : h >= 4 ? 0.8 : 0.55
  soft('gap', gap, 0.35, h == null ? '不知道多久没说话' : h >= 12 ? '确实隔了很久' : h >= 4 ? '隔了一阵' : '刚刚还在说话')

  soft('hour', inQuietHours(localHour(now), 1, 6) ? 0.35 : 0.85, 0.2, `${timeOfDayWord(localHour(now))}`)

  const totalWeight = gates.reduce((sum, g) => (g.soft ? sum + g.weight : sum), 0) || 1
  let score = gates.reduce((sum, g) => (g.soft ? sum + g.value * g.weight : sum), 0) / totalWeight
  // 两种毛病不是「稍微差一点」，是「听着就不对」，单独重罚：
  // 播报腔（把记忆当进度念）与语气不对（心里不轻松却硬装开心）。
  let penalty = 0
  if (BROADCAST.test(say)) penalty += 0.3
  if (tone < 0.5) penalty += 0.3
  score = Math.max(0, score - penalty)
  const speak = score >= Number(cfg.minScore ?? 0.58)
  return finish(speak, speak ? '说' : `分不够（${score.toFixed(2)}）`, gates, score)
}

function finish(speak, reason, gates, score = 0) {
  return { speak, score: Number(Number(score || 0).toFixed(3)), reason, gates }
}

/** 一行字说明判的结果，给日志和面板看。 */
export function explainVerdict(verdict) {
  if (!verdict) return ''
  const score = Number(verdict.score || 0).toFixed(2)
  if (!verdict.speak) return `不说（${verdict.reason}）`
  const good = (verdict.gates ?? []).filter((g) => g.soft && g.value >= 0.85).map((g) => g.note)
  const bad = (verdict.gates ?? []).filter((g) => g.soft && g.value < 0.5).map((g) => g.note)
  const parts = [`说（${score}）`, ...good.slice(0, 2)]
  if (bad.length) parts.push(`扣分：${bad.slice(0, 2).join('、')}`)
  return parts.join('·')
}

/**
 * 从几个候选里挑最该说的那个。
 * candidates: [{text, seed, seedAt, seedScope}]
 * @returns {{chosen: object|null, verdict: object, all: Array}}
 */
export function pickBest(candidates = [], options = {}) {
  let chosen = null
  let chosenVerdict = null
  const all = []
  for (const candidate of candidates ?? []) {
    if (!candidate?.text) continue
    const verdict = judgeUtterance({
      ...options,
      text: candidate.text,
      seed: candidate.seed,
      seedAt: candidate.seedAt,
      seedScope: candidate.seedScope,
    })
    all.push({ text: candidate.text, score: verdict.score, speak: verdict.speak, reason: verdict.reason })
    // 宁缺勿滥：分不够就不要，不拿「最不差」的凑数。
    if (!verdict.speak) continue
    if (!chosen || verdict.score > chosenVerdict.score) {
      chosen = candidate
      chosenVerdict = verdict
    }
  }
  if (chosen) return { chosen, verdict: chosenVerdict, all }
  const first = all[0] ?? null
  return {
    chosen: null,
    verdict: { speak: false, score: first?.score ?? 0, reason: first?.reason ?? '没有能出口的话', gates: [] },
    all,
  }
}
