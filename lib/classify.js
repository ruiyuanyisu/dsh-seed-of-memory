/**
 * 分层与巩固：把「写进来」和「留下来」分开。
 *
 * - 写入时：按 layer、线索词给一个初始 tier（working / short / long）；
 * - 巩固时：用行为证据（跨会话复现、被召回次数、重要度、情绪强度、是否明说）
 *   算一个分数，过线才升 long，工作记忆过期就退场。
 *
 * 原则：不用「正面/负面」当门槛，情绪只看强度 |valence|；
 * 判错可以降级，但每次升级都要留下理由。
 */

export const TIERS = ['working', 'short', 'long']

export const TIER_OF_LAYER = {
  persona: 'long',
  semantic: 'long',
  episodic: 'short',
  buffer: 'working',
}

const PERMANENT = /记住|记一下|别忘了|以后都|每次|总是|一直|永远|说好了|约定|名字|生日|答应过/
const TEMPORAL = /今天|今晚|昨天|刚才|刚刚|待会|明天|这周|这次|现在|等会/
const IDENTITY = /我叫|我的名字|我是|我喜欢|我讨厌|我习惯|我害怕|我在意|我重视|我决定/
const PLAN = /打算|计划|下次|以后|要去|想做|准备/
const AFFECT = /开心|难过|生气|害怕|焦虑|委屈|失望|感动|喜欢|讨厌|安心/

export function kindOf(text) {
  const value = String(text ?? '')
  if (/我叫|我的名字|我是[^真很太]/u.test(value)) return 'identity'
  if (/我喜欢|我讨厌|我习惯|我害怕|我在意|我重视|我决定/.test(value)) return 'preference'
  if (PLAN.test(value)) return 'plan'
  if (AFFECT.test(value)) return 'affect'
  if (/\d{4}|\d+月|\d+日|点|昨天|今天|刚才/.test(value)) return 'event'
  return 'fact'
}

/** 写入时的初判：给 tier 与可读理由。 */
export function classifyText(text, { layer = 'semantic', source = 'user-said' } = {}) {
  const value = String(text ?? '')
  const reasons = []
  let tier = TIER_OF_LAYER[layer] ?? 'long'
  reasons.push(`layer:${layer}`)

  if (PERMANENT.test(value)) {
    tier = 'long'
    reasons.push('cue:permanent')
  } else if (TEMPORAL.test(value)) {
    // 时间性的话默认短期；但身份/偏好类仍然长
    tier = IDENTITY.test(value) ? 'long' : 'short'
    reasons.push('cue:temporal')
  }
  if (IDENTITY.test(value)) {
    tier = 'long'
    reasons.push('cue:identity')
  }
  if (source === 'inferred') reasons.push('source:inferred')
  return { tier, kind: kindOf(value), reasons }
}

function clamp01(value, fallback = 0) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(0, Math.min(1, number))
}

const round2 = (value) => Math.round(value * 100) / 100

/**
 * 巩固评分。emotion 用 0..1 的「强度」，不要传带符号的效价。
 * 返回 { score, threshold, boost, parts }，parts 是给面板解释用的。
 */
export function promotionScore(row, { emotion = 0 } = {}) {
  const sessions = Math.max(1, Number(row.session_count ?? 1))
  const recalls = Math.max(0, Number(row.recalls ?? 0))
  const repeat = clamp01((sessions - 1) / 2) // 3 个会话就满
  const recall = clamp01(recalls / 5) // 5 次召回就满
  const importance = clamp01(row.importance ?? 0.5)
  const affect = clamp01(emotion)
  const explicit = PERMANENT.test(String(row.text ?? '')) ? 1 : 0
  const base = 0.3 * repeat + 0.25 * recall + 0.2 * importance + 0.15 * affect + 0.1 * explicit
  // 「倍速」：被召回、跨会话出现，会降低晋升门槛（最多降 0.12）
  const boost = round2(Math.min(0.12, 0.02 * recalls + 0.03 * (sessions - 1)))
  const threshold = round2(0.6 - boost)
  return {
    score: round2(base),
    threshold,
    boost,
    parts: {
      repeat: round2(repeat),
      recall: round2(recall),
      importance: round2(importance),
      affect: round2(affect),
      explicit,
    },
  }
}

export function explainScore(result) {
  const { parts } = result
  return [
    `跨会话 ${parts.repeat}`,
    `召回 ${parts.recall}`,
    `重要度 ${parts.importance}`,
    `情绪强度 ${parts.affect}`,
    parts.explicit ? '明说' : '未明说',
  ].join(' · ')
}
