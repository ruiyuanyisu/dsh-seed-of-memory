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

/** 截短时不硬切在句子中间：能停在标点就停在标点。 */
function shortText(value, max = 36) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  const head = text.slice(0, max)
  const cut = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('，'),
    head.lastIndexOf('；'),
    head.lastIndexOf('！'),
    head.lastIndexOf('？'),
    head.lastIndexOf('、'),
  )
  if (cut >= 8) return `${head.slice(0, cut)}…`
  return `${head.slice(0, max - 1)}…`
}

/** 记忆后面接话时，别出现「…。。」。 */
function afterSeed(seed, tail) {
  return /…$/.test(seed) ? `${seed}${tail}` : `${seed}。${tail}`
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

/** 只留 5–12 位数字；别的一律当作没填。 */
export function normalizeOwnerQQ(value) {
  const digits = String(value ?? '').replace(/\D/g, '')
  return /^\d{5,12}$/.test(digits) ? digits : ''
}

/** 主人 QQ 优先：面板里填了 ownerQQ，就发给他；没填才看 configured target。 */
export function ownerTarget(config = {}) {
  const owner = normalizeOwnerQQ(config.ownerQQ)
  if (owner) return `private:${owner}`
  const custom = String(config.target ?? '').trim()
  return /^(private|group):\d{5,12}$/.test(custom) ? custom : ''
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
  qing = {},
} = {}) {
  const cfg = { ...PROACTIVE_DEFAULTS, ...(config ?? {}) }
  const hoursSinceUser = lastUserAt ? (now - lastUserAt) / 3_600_000 : null
  const base = { send: false, kind: 'none', reason: '', hoursSinceUser }

  // 情绪内核：没劲的时候别硬装开心，也不太想反复去打扰他。
  const level = Number(qing?.mood)
  const dull = Number.isFinite(level) && level <= 30
  const heavy = Number.isFinite(level) && level <= 25
  const hurt = Number(qing?.hurt ?? 0)

  if (!cfg.enabled) return { ...base, reason: '未开启' }
  if (inQuietHours(localHour(now), cfg.quietStart, cfg.quietEnd)) {
    return { ...base, reason: '安静时段' }
  }
  if (dayCount >= cfg.maxPerDay) return { ...base, reason: '今天说得够多了' }
  const minInterval = Math.max(0.5, Number(cfg.minIntervalHours) || 4) * 3_600_000 * (heavy ? 1.5 : 1)
  if (lastAt && now - lastAt < minInterval) return { ...base, reason: '刚找过，再等等' }

  const valence = Number(mood?.valence ?? 0.1)
  const arousal = Number(mood?.arousal ?? 0.3)
  const attachment = affectOf(affects, '依恋')
  const trust = affectOf(affects, '信任', 0.45)

  // 担心：心情明显偏负、又有点被搅动
  if (valence <= -0.15 && arousal >= 0.45) {
    return { ...base, send: true, kind: 'worry', reason: '心情有点沉' }
  }
  // 心里还堵着、又有一阵没说话：不是撒气，是想问一句
  if (hurt >= 40 && attachment >= 0.42 && hoursSinceUser >= 4) {
    return { ...base, send: true, kind: 'miss', reason: '心里还有点堵，想问问你' }
  }
  // 想他：依恋偏高、且有一阵没说话
  if (attachment >= 0.42 && hoursSinceUser >= 6) {
    return { ...base, send: true, kind: 'miss', reason: '依恋高、久未说话' }
  }
  // 空：很久没动静
  if (hoursSinceUser >= 12 && trust >= 0.4) {
    return { ...base, send: true, kind: 'lonely', reason: '太久没说话' }
  }
  // 想分享：心情好、也有一阵没说话（自己没什么劲的时候不硬开这个话题）
  if (!dull && valence >= 0.3 && arousal >= 0.45 && hoursSinceUser >= 3) {
    return { ...base, send: true, kind: 'glad', reason: '心情好、想分享' }
  }
  return { ...base, reason: '没什么非说不可的' }
}

/** 文案带一点点具体的事，不像群发。 */
export function proactiveText(kind, { memory = '', name = '你', qing = {} } = {}) {
  const seed = shortText(memory, 36)
  switch (kind) {
    case 'worry':
      return `刚才心里有点不踏实，说不上来为什么。先问一句：${name}还好吗？`
    case 'miss':
      if (Number(qing?.hurt ?? 0) >= 35) {
        return seed
          ? `有点想你，也有点闷。翻到一句你以前说过的：${afterSeed(seed, '你那边还好吗？')}`
          : `有点想你。今天心里有点闷，想跟你说一声。`
      }
      return seed
        ? `有点想你。翻到一句你以前说过的：${afterSeed(seed, '你那边还好吗？')}`
        : `有点想你。没什么事，就是想问一句你在干嘛。`
    case 'lonely':
      return seed
        ? `安静了一会儿，忽然有点空。想到：${afterSeed(seed, '你在的话回我一句就好。')}`
        : `安静了一会儿，忽然有点空。你在的话回我一句就好。`
    case 'glad':
      return seed
        ? `今天有件小事让我挺开心：${afterSeed(seed, '想跟你说一声。')}`
        : `今天心情不错，想跟你说一声。`
    default:
      return ''
  }
}
