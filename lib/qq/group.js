/**
 * QQ 群：不是每条都接话，而是看「跟我有关」和「我现在想不想说」。
 *
 * 判断顺序（纯函数，便于测试）：
 *   1. @我 / 回复我 → 一定接（除非群功能关了）
 *   2. 话里提到「阿鱼」「Carys」→ 大概率接
 *   3. 命中有兴趣的词 → 按心情折算概率
 *   4. 什么都没沾 → 只有心情很旺时小概率插话；低落就潜水
 *
 * 心情用当前 mood（valence 愉悦、arousal 唤醒）折算成「说话电量」：
 *   电量高 → 愿意参与；电量低 → 只在被点到时开口。
 */

export const GROUP_DEFAULTS = {
  groupPolicy: 'smart',
  groupNames: ['阿鱼', 'Carys'],
  groupTopics: ['记忆', '插件', 'AI', '模型', '语音', '声音', '游戏', 'B站', '代码', 'DSH', 'DeepSeek', '鲸', '画画', '音乐'],
  groupMinGapSec: 120,
  groupMentionGapSec: 8,
  groupMaxPerHour: 8,
  groupMaxPerDay: 60,
  groupQuietStart: 0,
  groupQuietEnd: 7,
  groupRandomChance: 0.06,
}

const clamp01 = (n) => Math.min(1, Math.max(0, n))

export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** 话里有没有提到我的名字（中英文都算）。 */
export function aboutMe(text, names = GROUP_DEFAULTS.groupNames) {
  const body = normalizeText(text)
  if (!body) return false
  return names.some((name) => {
    const key = String(name ?? '').trim().toLowerCase()
    return key.length >= 2 && body.includes(key)
  })
}

/** 命中几个兴趣词。 */
export function interestHits(text, topics = GROUP_DEFAULTS.groupTopics) {
  const body = normalizeText(text)
  if (!body) return 0
  let hits = 0
  for (const topic of topics) {
    const key = String(topic ?? '').trim().toLowerCase()
    if (key && body.includes(key)) hits += 1
  }
  return hits
}

/** 兴趣分数：一个词 0.5，多一个 +0.15，最多 0.95。 */
export function interestScore(text, topics = GROUP_DEFAULTS.groupTopics) {
  const hits = interestHits(text, topics)
  if (hits === 0) return 0
  return Math.min(0.95, 0.5 + 0.15 * (hits - 1))
}

/** 说话电量：心情越好、越被搅动，越愿意在群里说话。 */
export function socialEnergy(mood = {}) {
  const valence = Number(mood?.valence ?? 0.1)
  const arousal = Number(mood?.arousal ?? 0.3)
  return clamp01(0.5 + 0.5 * valence + 0.5 * (arousal - 0.35))
}

/**
 * 决定这条群消息要不要接。
 * @returns {{reply: boolean, reason: string, chance: number, energy: number, interest: number}}
 */
export function decideGroupReply({
  text = '',
  mentioned = false,
  repliedToMe = false,
  mood = {},
  config = {},
  now = Date.now(),
  lastSpokeAt = 0,
  hourCount = 0,
  dayCount = 0,
  random = Math.random,
} = {}) {
  const cfg = { ...GROUP_DEFAULTS, ...(config ?? {}) }
  const energy = socialEnergy(mood)
  const interest = interestScore(text, cfg.groupTopics)
  const base = { reply: false, reason: '', chance: 0, energy, interest }

  if (cfg.groupPolicy === 'off') return { ...base, reason: '群聊已关闭' }

  const direct = mentioned || repliedToMe
  const named = aboutMe(text, cfg.groupNames)

  // 点数我的名：不受心情和时段限制，但要守频率
  if (direct) return { ...base, reply: true, reason: mentioned ? '@我' : '回复我', chance: 1 }

  if (dayCount >= cfg.groupMaxPerDay) return { ...base, reason: '今天在群里说够了' }
  if (hourCount >= cfg.groupMaxPerHour) return { ...base, reason: '这一小时说够了' }

  // 点我的名（没真的 @，但写了名字）：别让「刚说过」和安静时段把人挡在外面。
  // 自己被点名还装没听见，比多回一句更难受。
  if (named) {
    const hardDay = Number(cfg.groupMaxPerDay) * 2
    const hardHour = Number(cfg.groupMaxPerHour) * 2
    if (dayCount >= hardDay) return { ...base, reason: '今天在群里说够了' }
    if (hourCount >= hardHour) return { ...base, reason: '这一小时说够了' }
    const mentionGap = Math.max(0, Number(cfg.groupMentionGapSec ?? 8)) * 1000
    if (mentionGap && lastSpokeAt && now - lastSpokeAt < mentionGap) {
      return { ...base, reason: '刚说过，缓一缓' }
    }
    const chance = 0.85
    return { ...base, reply: random() < chance, reason: '提到我', chance }
  }

  const gap = Math.max(0, Number(cfg.groupMinGapSec) || 0) * 1000
  if (lastSpokeAt && now - lastSpokeAt < gap) return { ...base, reason: '刚说过，缓一缓' }

  const hour = new Date(now).getHours()
  const quiet = quietHour(hour, cfg.groupQuietStart, cfg.groupQuietEnd)
  if (quiet) return { ...base, reason: '安静时段' }

  // 低落：不主动插话
  const valence = Number(mood?.valence ?? 0.1)
  const arousal = Number(mood?.arousal ?? 0.3)
  if (valence <= -0.3 && arousal <= 0.45) return { ...base, reason: '今天不太想说话' }

  // 感兴趣：按电量折算
  if (interest > 0) {
    const chance = clamp01(interest * (0.4 + 0.6 * energy))
    return { ...base, reply: random() < chance, reason: `感兴趣（${Math.round(interest * 100)}%）`, chance }
  }

  // 什么都不沾：只有心情很旺时小概率插话
  if (energy >= 0.65) {
    const chance = clamp01(Number(cfg.groupRandomChance) * energy)
    if (random() < chance) return { ...base, reply: true, reason: '心情好，随便说一句', chance }
    return { ...base, reason: '没接上话', chance }
  }

  return { ...base, reason: energy < 0.35 ? '在潜水' : '没什么想说的' }
}

function quietHour(hour, start, end) {
  const s = Number(start)
  const e = Number(end)
  if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) return false
  if (s < e) return hour >= s && hour < e
  return hour >= s || hour < e
}

/** 群里回话后，把计数推进一格。 */
export function bumpGroupStats(stats = {}, now = Date.now()) {
  const day = new Date(now).toDateString()
  const hour = new Date(now).getHours()
  const sameDay = stats.day === day
  const sameHour = stats.hour === hour && stats.hourStart
  return {
    lastSpokeAt: now,
    day,
    dayCount: (sameDay ? Number(stats.dayCount) || 0 : 0) + 1,
    hour,
    hourStart: sameHour ? stats.hourStart : now,
    hourCount: (sameHour ? Number(stats.hourCount) || 0 : 0) + 1,
  }
}
