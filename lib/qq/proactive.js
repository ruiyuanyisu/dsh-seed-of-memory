/**
 * 主动找主人：只做「该不该开口」的判断与文案，不碰网络。
 * 纯函数，方便测试；真正的发送由 index.js 用 OneBot 客户端完成。
 */

export const PROACTIVE_DEFAULTS = {
  enabled: true,
  minIntervalHours: 4,
  maxPerDay: 3,
  quietStart: 23,
  quietEnd: 8,
  target: '',
}

function shortText(value, max = 40) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function localHour(now = Date.now()) {
  return new Date(now).getHours()
}

export function inQuietHours(hour, start = 23, end = 8) {
  if (start === end) return false
  if (start < end) return hour >= start && hour < end
  return hour >= start || hour < end
}

export function affectOf(affects, kind, fallback = 0.3) {
  const row = (affects ?? []).find((item) => item.kind === kind)
  return Number(row?.strength ?? fallback)
}

/**
 * 决定这一轮要不要主动说话。
 * @returns {{send: boolean, kind: string, reason: string, hoursSinceUser: number|null}}
 */
export function planProactive({
  now = Date.now(),
  mood = {},
  affects = [],
  lastAt = 0,
  lastUserAt = 0,
  dayCount = 0,
  config = {},
} = {}) {
  const cfg = { ...PROACTIVE_DEFAULTS, ...(config ?? {}) }
  const hoursSinceUser = lastUserAt ? (now - lastUserAt) / 3_600_000 : null
  const base = { send: false, kind: 'none', reason: '', hoursSinceUser }

  if (!cfg.enabled) return { ...base, reason: '未开启' }
  if (inQuietHours(localHour(now), cfg.quietStart, cfg.quietEnd)) {
    return { ...base, reason: '安静时段' }
  }
  if (dayCount >= cfg.maxPerDay) return { ...base, reason: '今天说得够多了' }
  const minInterval = Math.max(0.5, Number(cfg.minIntervalHours) || 4) * 3_600_000
  if (lastAt && now - lastAt < minInterval) return { ...base, reason: '刚找过，再等等' }

  const valence = Number(mood?.valence ?? 0.1)
  const arousal = Number(mood?.arousal ?? 0.3)
  const attachment = affectOf(affects, '依恋')
  const trust = affectOf(affects, '信任', 0.45)

  // 担心：心情明显偏负、又有点被搅动
  if (valence <= -0.15 && arousal >= 0.45) {
    return { ...base, send: true, kind: 'worry', reason: '心情偏negative' }
  }
  // 想他：依恋偏高、且有一阵没说话
  if (attachment >= 0.42 && hoursSinceUser >= 6) {
    return { ...base, send: true, kind: 'miss', reason: '依恋高、久未说话' }
  }
  // 空：很久没动静
  if (hoursSinceUser >= 12 && trust >= 0.4) {
    return { ...base, send: true, kind: 'lonely', reason: '太久没说话' }
  }
  // 想分享：心情好、也有一阵没说话
  if (valence >= 0.3 && arousal >= 0.45 && hoursSinceUser >= 3) {
    return { ...base, send: true, kind: 'glad', reason: '心情好、想分享' }
  }
  return { ...base, reason: '没什么非说不可的' }
}

/** 文案带一点点具体的事，不像群发。 */
export function proactiveText(kind, { memory = '', name = '你' } = {}) {
  const seed = shortText(memory, 36)
  switch (kind) {
    case 'worry':
      return `刚才心里有点不踏实，说不上来为什么。先问一句：${name}还好吗？`
    case 'miss':
      return seed
        ? `有点想你。翻到一句你以前说过的：${seed}。你那边还好吗？`
        : `有点想你。没什么事，就是想问一句你在干嘛。`
    case 'lonely':
      return seed
        ? `安静了一会儿，忽然有点空。想到：${seed}。你在的话回我一句就好。`
        : `安静了一会儿，忽然有点空。你在的话回我一句就好。`
    case 'glad':
      return seed
        ? `今天有件小事让我挺开心：${seed}。想跟你说一声。`
        : `今天心情不错，想跟你说一声。`
    default:
      return ''
  }
}
