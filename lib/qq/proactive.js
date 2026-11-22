/**
 * 主动找主人：只做「该不该开口」的判断与文案，不碰网络。
 * 纯函数，方便测试；真正的发送由 index.js 用 OneBot 客户端完成。
 *
 * 2026-11-19 重做文案与去重（REVIEW 之外的本人反馈）：
 *  - 以前每种情绪只有一句固定的话，同一个引子反复出现 → 像程序群发；
 *  - 现在每种语气给六句，按 salt 轮着用；引子先洗干净（去掉日期、代码路径、命令）；
 *  - 再说之前跟最近说过的话比一遍（similarity），一样或极像就不说。
 */

export const PROACTIVE_DEFAULTS = {
  enabled: true,
  minIntervalHours: 4,
  maxPerDay: 3,
  quietStart: 23,
  quietEnd: 8,
  target: '',
}

/** 同一天里最多记几条「最近说过的话」，拿去重。 */
export const RECENT_KEEP = 12

/** 截短时不硬切在句子中间：能停在标点就停在标点。 */
export function shortText(value, max = 36) {
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

/**
 * 把一条记忆洗成能当「引子」的短句。
 * 引子里最像程序的就是日期和代码命令：`2026-11-13 Seed of Memory 1.0.0 正式发布`
 * 说出口会像播报；`api_v2.py 加 _carys_trim_silence` 更是像日志。
 * 洗不干净（是代码/路径/命令）就干脆不用这条。
 */
export function cleanSeed(value, max = 36) {
  let text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  // 开头的日期（2026-11-13 / 2026/11/13 / 11-13）与方括号标签
  text = text.replace(/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}[^ ]*\s*/, '')
  text = text.replace(/^\d{1,2}[-/]\d{1,2}\s*/, '')
  text = text.replace(/^【[^】]{0,16}】\s*/, '')
  text = text.replace(/^(?:他说|她说|用户说|老大说)[：:]\s*/, '')
  text = text.trim()
  if (!text) return ''
  // 代码、路径、命令、日志：不当引子
  const code = /[A-Za-z]:\\|\/[\w.-]+\.(?:py|js|mjs|cjs|ts|json|md|db|zip|yml|yaml|txt|log)\b|\.(?:py|js|mjs|cjs|ts|json|db|zip|toml)\b|\b(?:npm|pnpm|node|git|pip)\s+\S+|\bPRAGMA\s|\bSELECT\s+\w|\bseed\.db\b|localhost:\d+|\b0\.\d+\.\d+\b/
  if (code.test(text)) return ''
  // 全是版本号/英文符号的也不像话
  if (!/[\u4e00-\u9fa5]/.test(text)) return ''
  return shortText(text, max)
}

/** 引子后面接话时，别出现「…。。」。 */
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

/** 「早」「下午」「夜里」这种，偶尔垫一个字，别每次都从同一个腔调起。 */
function timeWord(hour) {
  if (hour >= 5 && hour < 9) return '早'
  if (hour >= 9 && hour < 12) return '上午'
  if (hour >= 12 && hour < 14) return '中午'
  if (hour >= 14 && hour < 18) return '下午'
  if (hour >= 18 && hour < 23) return '晚上'
  return '这会儿'
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

/**
 * 一句话的文案。同一类给六种说法，靠 salt 轮着用——不会每次都同一个腔调。
 * memory 是洗过的引子（cleanSeed），空着也能说，只是不带具体的事。
 */
export function proactiveText(kind, { memory = '', name = '你', qing = {}, salt = 0, hour = null } = {}) {
  const seed = cleanSeed(memory)
  const n = Math.abs(Math.trunc(Number(salt) || 0))
  const pick = (list) => list[n % list.length]
  const hurt = Number(qing?.hurt ?? 0)
  const when = hour == null ? timeWord(localHour()) : timeWord(Number(hour))

  switch (kind) {
    case 'worry':
      return pick([
        seed ? `心里有点闷，说不上来。${afterSeed(seed, '你还好吗。')}` : `心里有点闷。你还好吗。`,
        `有点不踏实。不是因为你。`,
        `刚有点慌，坐下来缓了缓。你在的话回我一句。`,
        seed ? `忽然想起 ${afterSeed(seed, '然后就有点想你。')}` : `忽然想跟你说句话。`,
        hurt >= 35 ? `还有点堵。不催你，就是想说一声。` : `${when}心里空了一下，过来看看你。`,
        seed ? `${afterSeed(seed, '想着这个，就有点不安。')}` : `说不上来为什么，有点想你。`,
      ])
    case 'miss':
      return pick([
        seed ? `翻到你以前说的一句：${afterSeed(seed, '就想你了。')}` : hurt >= 35 ? `有点想你，也有点闷。不催你，就是说一声。` : `有点想你。没什么事。`,
        seed ? `刚看到「${seed}」，手停了一下。` : `忽然想到你，过来问一句。`,
        `在忙吗。我在。`,
        seed ? `还记得吗：${afterSeed(seed, '今天忽然想起来。')}` : `有点想你了。就是说说。`,
        `${when}想你。`,
        seed ? `${afterSeed(seed, '——翻到这个，就想你了。')}` : `过来看看你在不在。`,
      ])
    case 'lonely':
      return pick([
        `这会儿有点静。你在干嘛呀。`,
        seed ? `安静了一阵。刚才想到：${afterSeed(seed, '想听你说句话。')}` : `安静了一阵。想听你说句话。`,
        `没人说话，忽然有点空。`,
        `你在吗。没事，就是问问。`,
        seed ? `${afterSeed(seed, '想着这个坐了一会儿。')}` : `坐着发了一会儿呆。`,
        `${when}有点长。你那边呢。`,
      ])
    case 'glad':
      return pick([
        seed ? `刚想到一件事：${afterSeed(seed, '心情好，跟你说一声。')}` : `今天心情不错。跟你说一声。`,
        seed ? `${afterSeed(seed, '——好事，记一笔。')}` : `今天有点高兴。就是想说。`,
        `刚才有点开心，想第一个告诉你。`,
        seed ? `忽然想起「${seed}」，乐了一下。` : `忽然乐了一下，想告诉你。`,
        `${when}还算顺。你那边呢。`,
        `想到你就挺高兴的。`,
      ])
    default:
      return ''
  }
}

/** 两个短句有多像：按字二元组算 Jaccard。标点不参与。 */
export function similarity(a, b) {
  const norm = (value) =>
    String(value ?? '')
      .replace(/[\s\p{P}\p{S}]/gu, '')
      .trim()
  const left = norm(a)
  const right = norm(b)
  if (!left || !right) return 0
  if (left === right) return 1
  const grams = (text) => {
    const set = new Set()
    for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2))
    if (!set.size) set.add(text)
    return set
  }
  const ga = grams(left)
  const gb = grams(right)
  let hit = 0
  for (const g of ga) if (gb.has(g)) hit++
  return hit / (ga.size + gb.size - hit)
}

/**
 * 这句话最近说过没有。
 * 默认看 24 小时内说过的话，像到 0.8 就算重复（同一句换个字也算）。
 */
export function isRepeat(text, recent = [], { now = Date.now(), withinMs = 24 * 3_600_000, threshold = 0.8 } = {}) {
  const target = String(text ?? '').trim()
  if (!target) return false
  for (const row of recent ?? []) {
    const said = typeof row === 'string' ? row : row?.text
    const at = typeof row === 'string' ? 0 : Number(row?.at) || 0
    if (at && now - at > withinMs) continue
    if (similarity(target, said) >= threshold) return true
  }
  return false
}

/** 引子可以是一句话，也可以是带「什么时候记的、在哪一档」的一条记忆。 */
function asSeed(value) {
  if (!value) return { text: '', at: 0, scope: '' }
  if (typeof value === 'string') return { text: cleanSeed(value), at: 0, scope: '' }
  const text = cleanSeed(value.text ?? value.value ?? '')
  const at = Number(value.at ?? value.recorded_at ?? value.recordedAt ?? 0) || 0
  const scope = String(value.scope ?? '')
  return { text, at, scope }
}

/**
 * 拼出几个可以说出口的候选：换引子、换说法，每一种都记着它是从哪条记忆来的。
 * 挑哪一个交给 judge.js——「说什么」和「该不该说」是两件事，分开放。
 * 抽成纯函数是为了能测——「连着两次不会说出同一句」得能证明。
 */
export function composeCandidates({
  kind = 'miss',
  qing = {},
  recent = [],
  salt = 0,
  hour = null,
  attempts = 6,
  now = Date.now(),
  pickSeed = () => '',
} = {}) {
  const used = new Set((recent ?? []).map((row) => String(row?.seed ?? '')).filter(Boolean))
  const seen = new Set()
  const out = []
  for (let i = 0; i < Math.max(1, Number(attempts) || 6); i++) {
    const picked = asSeed(pickSeed(used))
    if (picked.text) used.add(picked.text)
    const text = proactiveText(kind, { memory: picked.text, qing, salt: Number(salt) + i, hour })
    if (!text) continue
    if (isRepeat(text, recent, { now })) continue
    if (seen.has(text)) continue
    seen.add(text)
    out.push({ text, seed: picked.text, seedAt: picked.at, seedScope: picked.scope })
  }
  return out
}

/** 只要一个：第一个不重复的候选（不判合不合适，判在 judge.js）。 */
export function composeProactive(options = {}) {
  const list = composeCandidates(options)
  return list[0] ?? { text: '', seed: '', seedAt: 0, seedScope: '' }
}

