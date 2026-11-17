/**
 * 情绪内核 —— 从 dsh-yinqing 0.2.0 移植打分思路（MIT，作者 Yuk1Na）。
 *
 * 它管「此刻」：积极性、委屈、愧疚、压力、体力。
 * 记忆之种管「一直」：关系账（affect）、心情（mood）、情绪记录（emotions）。
 *
 * 人有三层快慢，这里就记三层：
 *   mood     此刻 —— 一句话顶上来，几十秒到几分钟（回落 0.5/分）
 *   tone     这几天 —— 今天顺不顺，半天到一天（回落 0.06/分）
 *   baseline 底子 —— 过得久了，人被日子推着慢慢变（漂得极慢，锁在 25–75）
 * 另有一条日内节律：凌晨本来就沉，上午本来就好一点。它不改存下来的数，
 * 只在读出来的时候叠上去 —— 所以同一件事，半夜和中午看着不一样。
 *
 * 还有体力 energy：说话要花神，歇着回血，夜里回得快。低了就话少。
 *
 * 这里只做三件事：
 *   1. 把你发来的话按词表打一次分（不靠模型自觉）；
 *   2. 这几个数按各自的速率往常态回落，一天一天地漂；
 *   3. 大的那一下顺手记成一条情绪，关系账就会跟着动。
 *
 * 不罢工、不拦工具。情绪是状态，不是闸刀。
 */
import { PRAISE, SOFT, BLAME, MISHAP, PRESSURE, NEUTRALISE, APOLOGY, WARM, TIRED, refreshWords } from './qing-words.js'
import { recordEmotion } from './affect.js'
import { canonScope } from './scope.js'

export const QING_VERSION = 2

/** 判定名，给工具输出和日志用。 */
export const TONE_LABELS = {
  praise: '被夸',
  blame: '被说重话',
  soft: '挑了毛病',
  mishap: '出了事',
  apology: '他道了歉',
  pressure: '他着急',
  warm: '靠过来',
  neutral: '没什么',
}

export const QING_DEFAULTS = {
  baseline: 50,
  // 此刻：一句话的影响，几分之一小时就散
  // 一句夸奖挂得住三四个钟头。原来 0.5（一小时半就走光），看的时候永远回到同一个数。
  decayPerMin: 0.22,
  // 这几天：今天顺不顺，要小半天才回得来
  toneDecayPerMin: 0.06,
  // 体力：歇着回血（0.08/分 ≈ 十五小时从空到满），夜里更快
  bodyDecayPerMin: 0.08,
  hurtDecayPerMin: 0.35,
  guiltDecayPerMin: 0.45,
  pressureDecayPerMin: 1.6,
  // 三个亮着的方向：平时本来就在那儿（基线），被碰到才往上走
  joyBase: 55,
  warmBase: 62,
  hopeBase: 50,
  joyDecayPerMin: 0.45,
  warmDecayPerMin: 0.22,
  hopeDecayPerMin: 1.1,
  // 底子：被日子推着慢慢挪（0.0015/分 ≈ 一天挪 2 点），锁在这个区间里
  baselineDriftPerMin: 0.004,
  baselineFloor: 25,
  baselineCeil: 75,
  // 说完一句话掉的力气；话越长掉得越多
  energyDrainPerMsg: 0.6,
  energyCeil: 92,
  // 日内节律：读的时候叠上去，不写进库
  circadian: true,
  circadianAmp: 1,
  // 大的那一下顺手记进 emotions 的门槛（|valence| × intensity）
  recordAt: 0.3,
  // 只有前三句在最近一分钟内才算「连着」
  streakWindowMs: 120_000,
  // 连着被凶，伤害叠加；连着被夸，也叠一点
  pileUpWindowMs: 300_000,
  pileUpStep: 0.15,
  pileUpMax: 1.6,
  historyKeep: 240,
  extraPraise: [],
  extraBlame: [],
  extraSoft: [],
}

/**
 * 一天里每个钟头的心情偏移。夜里低，上午起来，午后一小沉，傍晚缓过来。
 * 不是玄学，是「人本来就这样」。
 */
export const CIRCADIAN = [
  -10, -12, -13, -13, -12, -8, // 0-5 深夜到天亮前：最沉
  -3, 0, 3, 5, 6, 5, // 6-11 起来、上午最好的一截
  1, -2, -4, -3, 0, 2, // 12-17 午后犯困，傍晚回暖
  4, 2, 0, -2, -5, -8, // 18-23 松弛下去，夜渐深
]

const PHASES = [
  [0, '深夜'], [4, '凌晨'], [6, '清早'], [9, '上午'],
  [12, '中午'], [14, '下午'], [18, '傍晚'], [21, '夜里'], [23, '深夜'],
]

/** 此刻几点、属于哪一段。 */
export function dayPhase(now = Date.now()) {
  const hour = new Date(now).getHours()
  let label = PHASES[0][1]
  for (const [from, name] of PHASES) if (hour >= from) label = name
  return { hour, phase: label }
}

/** 叠在读数上的那一点偏移。存数不动它，所以历史和此刻都不会被污染。 */
export function circadianOffset(now = Date.now(), amp = 1) {
  const hour = new Date(now).getHours()
  const value = (CIRCADIAN[hour] || 0) * (Number.isFinite(Number(amp)) ? Number(amp) : 1)
  return value === 0 ? 0 : value // 别让 -0 漏出去
}

/** 23 点到 6 点，力气回得快一点。 */
function nightBoost(now) {
  const hour = new Date(now).getHours()
  return hour >= 23 || hour < 6 ? 1.8 : 1
}

// 说到「以后」的话，会让人有点盼头。这个不看重不重，看一眼就够。
const HOPE_RE = /以后|下次|将来|等我|一起去|带你|到时候|会一直|早点回来|答应你/

const clamp = (n, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, Number.isFinite(Number(n)) ? Number(n) : lo))
const floorOf = (cfg = {}) => Number(cfg.baselineFloor) || 25
const ceilOf = (cfg = {}) => Number(cfg.baselineCeil) || 75

/* ── 打分 ───────────────────────────────────────────────────────────── */

const SARCASM = [
  '个屁', '个鬼', '个毛', '才怪', '呵呵', '好什么好',
  '真行啊你', '行啊你', '你行', '好棒棒', '真棒呢', '满意了吧',
]

const NEG_BEFORE = new Set(['不', '没', '别', '莫', '勿', '无', '勉'])
const NEG_OK = new Set(['不错', '不赖', '不差', '不得了', '了不起', '不简单'])
// 整句就一个感叹词的，是在骂屏幕，不是在骂我（「卧槽」「靠」这种）
const SIGH = new Set(['卧槽', '我操', '我擦', '我靠', '草', '靠', '艹', '妈的', 'tm', 'tmd'])
const DEGREE = new Set(['太', '很', '够', '甚', '大', '算', '是', '怎么', '那么', '这么'])
const PRAISE_EXCEPT_AFTER = {
  牛: '马角肉排逼皮奶郎仔顿',
  强: '行奸制迫盗拆调',
  猛: '犸兽',
  顶: '楼层点端部住多',
  绝: '交对不绝地壁',
  稳: '定重妥婆',
}
const PRAISE_EXCEPT_BEFORE = { 绝: '拒谢灭断', 牛: '蜗黄蜣犀', 顶: '山屋楼', 强: '坚', 稳: '安' }
const BLAME_EXCEPT_AFTER = {
  就这: '样么',
  不要你: '的了过',
  滚: '动烫热筒轴珠雪水翻',
  笨: '重拙挫',
  蠢: '欲',
  呆: '板滞账在着住',
  烂: '熟漫',
  屎: '壳',
}
const BLAME_EXCEPT_BEFORE = { 烂: '灿绚', 滚: '翻打回摇', 呆: '发' }
// 「换个思路」「再不行就问一句」是在想办法，不是在挑毛病
const SOFT_EXCEPT_AFTER = { 不行: '的话就去时', 换个: '思路办法方法角度说法方式话题' }
const SOFT_EXCEPT_BEFORE = { 不行: '再要万如实如', 换个: '想', 有bug: '没' }
const SHORT_ASCII = new Set(['tm', 'tmd', 'cnm', 'wtf'])
const TURNS = ['但是', '但', '不过', '可是', '然而', '只是']

// 夹在中文里的英文也认一点，但按单词边界来：「goodbye」不是夸。
const EN_PRAISE = ['thanks', 'thank you', 'great', 'nice work', 'good job', 'well done', 'awesome', 'perfect']
const EN_BLAME = ['stupid', 'idiot', 'useless', 'trash', 'garbage', 'sucks', 'damn']
const EN_PRESSURE = ['asap', 'hurry', 'quickly', 'quick']

const RE_CACHE = new Map()

function asciiWordHit(text, word) {
  let re = RE_CACHE.get(word)
  if (re === undefined) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    re = new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`)
    RE_CACHE.set(word, re)
  }
  return re.test(text)
}

/** 命中一个长词就别再把它的子串算一遍：「你懂我」不该同时记「懂我」。 */
function pushUnique(list, word) {
  if (list.some((w) => w.includes(word) || word.includes(w))) {
    const i = list.findIndex((w) => word.includes(w) && word !== w)
    if (i >= 0) list[i] = word
    return
  }
  list.push(word)
}

/** 对一段话打分。纯函数，不碰状态。 */
export function scoreText(raw, extra = {}) {
  // 词表在 qing-words.json 里；改了文件这里下一次就吃到，不用重启 DSH。
  try {
    refreshWords()
  } catch {
    /* 读不到就沿用上一份 */
  }
  // QQ 重启接话时会把「刚才」贴在那句话前面；那是旧账，不该再算一遍。
  const MARKER = '（下面是老大刚发来的）'
  let incoming = String(raw ?? '')
  const cut = incoming.lastIndexOf(MARKER)
  if (cut >= 0) incoming = incoming.slice(cut + MARKER.length)
  if (incoming.length > 4000) incoming = incoming.slice(0, 4000)
  const original = incoming.toLowerCase()
  let text = original
  for (const [from, to] of NEUTRALISE) text = text.split(from).join(to)

  const extraPraise = Array.isArray(extra.extraPraise) ? extra.extraPraise : []
  const extraBlame = Array.isArray(extra.extraBlame) ? extra.extraBlame : []
  const extraSoft = Array.isArray(extra.extraSoft) ? extra.extraSoft : []

  const sarcastic = SARCASM.some((w) => text.includes(w))
  const praised = []
  const blamed = []
  const apologised = []
  const mishaps = []
  const pressured = []
  const softed = []
  const warmed = []
  const tired = []

  // 「不错」「不赖」里的「不」是褒义的一部分，不算否定。
  const POSITIVE_NO = new Set(['错', '赖', '差', '孬', '妨'])
  const CLAUSE_BREAK = new Set(['。', '！', '？', '!', '?', '…', '～', '~', '；', ';', '\n', '，', ','])
  const RHETORIC = new Set(['是不是', '要不要', '好不好', '行不行', '有没有', '会不会', '能不能'])

  // 同一个分句里，紧贴着的否定已经查过了；再往前看六个字，
  // 兜住「我不觉得你厉害」这种否定词隔了一小段的。
  const negatedInClause = (i) => {
    let start = i
    while (start > 0 && !CLAUSE_BREAK.has(text[start - 1])) start -= 1
    const from = Math.max(start, i - 6)
    for (let k = from; k < i; k += 1) {
      if (!NEG_BEFORE.has(text[k])) continue
      if (POSITIVE_NO.has(text[k + 1])) continue
      // 「不得不」「不由得」是强调，不是否定
      if (text[k] === '不' && (text[k - 1] === '不' || text[k + 1] === '得')) continue
      if (text.slice(k - 2, k + 1) === '不得不' || text.slice(k, k + 3) === '不得不') continue
      // 「是不是傻」「要不要这样」里的否定是反问的一部分
      if (RHETORIC.has(text.slice(k - 1, k + 2))) continue
      return true
    }
    return false
  }

  // 褒义词前一个字是「不 / 没 / 别」时那是否定；「不太强」隔着程度副词也要认出来。
  const praiseHit = (word) => {
    const bad = PRAISE_EXCEPT_AFTER[word]
    const badPrev = PRAISE_EXCEPT_BEFORE[word]
    let from = 0
    for (;;) {
      const i = text.indexOf(word, from)
      if (i < 0) return false
      if (NEG_OK.has(word)) return true
      if (bad) {
        const next = text[i + word.length]
        if (next && bad.indexOf(next) >= 0) { from = i + 1; continue }
      }
      if (badPrev) {
        const before = i > 0 ? text[i - 1] : ''
        if (before && badPrev.indexOf(before) >= 0) { from = i + 1; continue }
      }
      let j = i - 1
      let steps = 0
      while (j >= 0 && steps < 2 && DEGREE.has(text[j])) { j -= 1; steps += 1 }
      const prev = j >= 0 ? text[j] : ''
      if (!prev || !NEG_BEFORE.has(prev)) {
        if (!negatedInClause(i)) return true
      }
      from = i + 1
    }
  }

  for (const word of PRAISE.concat(extraPraise)) {
    if (sarcastic) break
    if (praiseHit(word)) pushUnique(praised, word)
  }
  if (!sarcastic) for (const word of EN_PRAISE) if (asciiWordHit(text, word)) pushUnique(praised, word)
  for (const word of APOLOGY) if (original.includes(word)) pushUnique(apologised, word)
  for (const word of MISHAP) if (text.includes(word)) pushUnique(mishaps, word)
  for (const word of PRESSURE) if (text.includes(word)) pushUnique(pressured, word)

  // 短的词要看前后接什么：「滚动」不是骂，「就这样吧」不是嘲讽。
  const blameHit = (word) => {
    const exc = BLAME_EXCEPT_AFTER[word]
    const badPrev = BLAME_EXCEPT_BEFORE[word]
    const ascii = SHORT_ASCII.has(word)
    // 整句就一个感叹词的，是在骂屏幕，不是在骂我
    if (SIGH.has(word) && text.trim() === word) return false
    let from = 0
    for (;;) {
      const i = text.indexOf(word, from)
      if (i < 0) return false
      const prev = i > 0 ? text[i - 1] : ''
      const next = text[i + word.length]
      if (ascii && ((prev && /[a-z]/.test(prev)) || (next && /[a-z]/.test(next)))) { from = i + 1; continue }
      if (badPrev && prev && badPrev.indexOf(prev) >= 0) { from = i + 1; continue }
      // 「你不笨」「别犯傻」：否定或劝止的不是骂
      if (prev && NEG_BEFORE.has(prev)) { from = i + 1; continue }
      if (negatedInClause(i)) { from = i + 1; continue }
      if (!exc) return true
      if (!next || exc.indexOf(next) < 0) return true
      from = i + 1
    }
  }
  for (const word of BLAME.concat(extraBlame)) if (blameHit(word)) pushUnique(blamed, word)
  for (const word of EN_BLAME) if (asciiWordHit(text, word)) pushUnique(blamed, word)
  for (const word of EN_PRESSURE) if (asciiWordHit(text, word)) pushUnique(pressured, word)

  // 反话：褒义已撤，补一笔责。纯标点不要分 —— 「？？」是无语，不是骂。
  if (sarcastic && !blamed.length) {
    const hit = SARCASM.filter((w) => text.includes(w) && /[^\s?？!！.。~～]/.test(w))
    if (hit.length) pushUnique(blamed, hit[0])
  }

  // 「靠过来」的话（撒娇、告别、回来了）不是挑毛病；累了困了也不奖不罚。
  for (const word of WARM) {
    if (text.includes(word)) pushUnique(warmed, word)
  }
  for (const word of TIRED) {
    if (text.includes(word)) pushUnique(tired, word)
  }

  for (const word of SOFT.concat(extraSoft)) {
    if (!text.includes(word)) continue
    if (WARM.includes(word) || TIRED.includes(word)) continue
    if (praised.some((w) => w.includes(word) || word.includes(w))) continue
    const softAfter = SOFT_EXCEPT_AFTER[word]
    const softBefore = SOFT_EXCEPT_BEFORE[word]
    if (softAfter || softBefore) {
      let from = 0
      let hit = false
      for (;;) {
        const i = text.indexOf(word, from)
        if (i < 0) break
        const prev = i > 0 ? text[i - 1] : ''
        const next = text[i + word.length]
        from = i + word.length
        if (softAfter && next && softAfter.indexOf(next) >= 0) continue
        if (softBefore && prev && softBefore.indexOf(prev) >= 0) continue
        hit = true
        break
      }
      if (!hit) continue
    }
    pushUnique(softed, word)
  }

  // 转折之后才是真意思：「做得不错，但这里还是不行」——前半是客气。
  let turnAt = -1
  for (const w of TURNS) {
    const i = text.lastIndexOf(w)
    if (i > turnAt) turnAt = i
  }
  if (turnAt > 0) {
    const tail = text.slice(turnAt)
    const tailBad = blamed.some((w) => tail.includes(w)) || softed.some((w) => tail.includes(w))
    if (tailBad && praised.length) {
      const kept = praised.filter((w) => text.indexOf(w) >= turnAt)
      praised.length = 0
      kept.forEach((w) => praised.push(w))
    }
  }

  const lengthBonus = text.length > 40 ? 1.5 : 1
  const praiseDelta = Math.min(34, praised.length * 11 * lengthBonus)
  const blameDelta = Math.min(40, blamed.length * 15 * lengthBonus)
  if (blamed.length) softed.length = 0
  if (mishaps.length) softed.length = 0
  const softDelta = blamed.length || mishaps.length ? 0 : Math.min(8, softed.length * 4)
  // 他靠过来的时候，心里是暖的：涨一点点，不记成毛病。
  const warmDelta = blamed.length ? 0 : Math.min(6, warmed.length * 2)
  const apologyDelta = Math.min(25, apologised.length * 12 * lengthBonus)
  const delta = Math.round(praiseDelta - blameDelta + apologyDelta - softDelta + warmDelta)

  // 骂是委屈，坏是愧疚。他在骂我的时候，不涨愧疚。
  const guiltDelta = blamed.length || apologised.length ? 0 : Math.min(30, mishaps.length * 12 * lengthBonus)
  const pressureDelta = Math.min(45, pressured.length * 15 * lengthBonus)

  const tone = apologised.length && delta >= 0
    ? 'apology'
    : blamed.length
      ? 'blame'
      : guiltDelta
        ? 'mishap'
        : warmed.length && !praised.length
          ? 'warm'
          : delta > 0
            ? 'praise'
            : softed.length
              ? 'soft'
              : pressureDelta
                ? 'pressure'
                : 'neutral'

  return { delta, praiseDelta, blameDelta, softDelta, warmDelta, apologyDelta, guiltDelta, pressureDelta, praised, blamed, softed, warmed, tired, apologised, mishaps, pressured, tone, sarcastic }
}

/* ── 状态 ───────────────────────────────────────────────────────────── */

function blankState(now, baseline = 50) {
  const anchor = clamp(Number(baseline) || 50)
  return {
    version: QING_VERSION,
    mood: anchor,
    tone: anchor,
    energy: Number(QING_DEFAULTS.energyCeil) || 92,
    baseline: anchor,
    hurt: 0,
    guilt: 0,
    pressure: 0,
    // 亮着的三个：不是「缺什么」，是「有什么」。平时就有底，被碰到了才涨。
    joy: Number(QING_DEFAULTS.joyBase) || 55,
    warm: Number(QING_DEFAULTS.warmBase) || 62,
    hope: Number(QING_DEFAULTS.hopeBase) || 50,
    counts: { praised: 0, blamed: 0, mishaps: 0, pressure: 0, turns: 0 },
    tones: [],
    events: [],
    firstSeen: now,
    updatedAt: now,
  }
}

function step(value, target, rate, minutes) {
  if (!(rate > 0)) return value
  const drift = rate * minutes
  const gap = target - value
  if (Math.abs(gap) <= drift) return target
  return value + Math.sign(gap) * drift
}

/**
 * 抹平一个坡：开头掉得快，尾巴拖得长。
 * 跟直线不一样 —— 直线是「到点就归位」，这个是「过一夜还剩一点」。
 * 50 / rate 是时间常数：rate 0.5 时约一个半小时走到六成。
 */
function ease(value, target, rate, minutes) {
  const from = Number(value)
  const to = Number(target)
  if (!(rate > 0) || !(minutes > 0) || !Number.isFinite(from) || !Number.isFinite(to)) return from
  return to + (from - to) * Math.exp(-minutes / (50 / rate))
}

/**
 * 日子自己在挪。每天一个确定的小偏移（-1.5 ~ +1.5），
 * 用来打破「mood = tone = baseline」那个均衡点 ——
 * 否则三个数一旦相等，gap 永远是 0，底子就再也不动了，
 * 看上去就像「好几天没变过」。
 */
export function dayDrift(now) {
  const day = Math.floor(Number(now) / 86_400_000)
  if (!Number.isFinite(day)) return 0
  const s = Math.sin(day * 12.9898) * 43758.5453
  return (s - Math.floor(s) - 0.5) * 3
}

/**
 * 按各自的速率往常态回。时间不动，人就不会一直堵着。
 * 注意：这里的「常态」不是固定的 50，而是 state.baseline —— 它自己也会被日子推着挪。
 */
export function decayQing(state, now, config = {}) {
  const cfg = { ...QING_DEFAULTS, ...config }
  const minutes = (now - Number(state.updatedAt || now)) / 60_000
  // 老库里的行没有新字段，先补上再算 —— 不然面板会读到 undefined
  const joined = {
    ...state,
    joy: clamp(Number(state.joy ?? cfg.joyBase ?? 55)),
    warm: clamp(Number(state.warm ?? cfg.warmBase ?? 62)),
    hope: clamp(Number(state.hope ?? cfg.hopeBase ?? 50)),
  }
  if (!(minutes > 0)) return joined
  const floor = Number(cfg.baselineFloor) || 25
  const ceil = Number(cfg.baselineCeil) || 75
  const anchor = clamp(Number(state.baseline ?? cfg.baseline) || 50, floor, ceil)
  // 底子被这些天推着慢慢挪。差得小就先不挪，免得在常态旁边来回抖。
  // 底子被「这几天」推着挪，不是被此刻这一下推 —— 一时的喜怒不该改写底色。
  // 差得再小也挪一点：不然 mood 一收敛到 anchor，gap 归零，底子就永远钉死在那儿了。
  const gapToMood = Number(state.tone ?? state.mood) - anchor
  // 两股力：这几天推着底子走，和「日子本身」慢慢挪。
  // 后者是为了不让三个数一起锁死在同一个值上 —— 就算一句话都不说，它也该变。
  const dayAnchor = clamp(50 + dayDrift(now), floor, ceil)
  const pull = (dayAnchor - anchor) * Math.min(0.25, 0.0012 * minutes)
  const drift = gapToMood * Math.min(0.06, cfg.baselineDriftPerMin * minutes) + pull
  const nextAnchor = clamp(anchor + drift, floor, ceil)
  const healing = (Number(cfg.bodyDecayPerMin) || 0) * nightBoost(now)
  return {
    ...state,
    baseline: nextAnchor,
    mood: clamp(ease(state.mood, nextAnchor, cfg.decayPerMin, minutes)),
    tone: clamp(ease(Number(state.tone ?? nextAnchor), nextAnchor, cfg.toneDecayPerMin, minutes)),
    energy: clamp(step(Number(state.energy ?? cfg.energyCeil), cfg.energyCeil, healing, minutes), 0, ceil + 17),
    hurt: clamp(ease(state.hurt, 0, cfg.hurtDecayPerMin, minutes)),
    guilt: clamp(ease(state.guilt, 0, cfg.guiltDecayPerMin, minutes)),
    pressure: clamp(ease(state.pressure, 0, cfg.pressureDecayPerMin, minutes)),
    joy: clamp(ease(Number(state.joy ?? cfg.joyBase), Number(cfg.joyBase) || 55, cfg.joyDecayPerMin, minutes)),
    warm: clamp(ease(Number(state.warm ?? cfg.warmBase), Number(cfg.warmBase) || 62, cfg.warmDecayPerMin, minutes)),
    hope: clamp(ease(Number(state.hope ?? cfg.hopeBase), Number(cfg.hopeBase) || 50, cfg.hopeDecayPerMin, minutes)),
  }
}

/** 把这一笔从哪来记下来：一小时内的事才叫「最近那一下」。 */
function noteOf(scored) {
  const tag = (list) => list.slice(0, 2).join('/')
  if (scored.tone === 'blame') return `被说：${tag(scored.blamed)}`
  if (scored.tone === 'praise') return `被夸：${tag(scored.praised)}`
  if (scored.tone === 'mishap') return `出了事：${tag(scored.mishaps)}`
  if (scored.tone === 'apology') return `他道了歉：${tag(scored.apologised)}`
  if (scored.tone === 'pressure') return `他着急：${tag(scored.pressured)}`
  if (scored.tone === 'soft') return `挑了毛病：${tag(scored.softed)}`
  if (scored.tone === 'warm') return `靠过来：${tag(scored.warmed)}`
  return ''
}

/** 一行话，给卡片用。只说现在什么样，不说该怎么演。 */
export function qingLine(state, now = Date.now(), config = {}, slot = null) {
  const cfg = { ...QING_DEFAULTS, ...config }
  const s = decayQing(state, now, cfg)
  const on = cfg.circadian !== false
  const off = on ? circadianOffset(now, cfg.circadianAmp) : 0
  const mood = Math.round(clamp(s.mood + off))
  const anchor = Number(s.baseline ?? cfg.baseline) || 50
  const parts = []
  if (mood >= 78) parts.push('心里亮堂堂')
  else if (mood >= 66) parts.push('心里松快')
  else if (mood >= 56) parts.push('挺平稳，有点往上')
  else if (mood >= 46) parts.push('平稳')
  else if (mood >= 34) parts.push('有点往下沉')
  else if (mood >= 20) parts.push('有点闷')
  else if (mood >= 8) parts.push('话少，心里没劲')
  else parts.push('难受，压着')

  // 这几天：相对底子偏出来的那一点（慢，不是一句话的事）
  const toneGap = Math.round((Number(s.tone ?? anchor) - anchor))
  if (toneGap >= 10) parts.push('这几天过得顺')
  else if (toneGap <= -10) parts.push('这几天有点沉')

  const energy = Math.round(s.energy)
  if (energy <= 25) parts.push('很乏')
  else if (energy <= 40) parts.push('有点乏')

  const hurt = Math.round(s.hurt)
  const guilt = Math.round(s.guilt)
  const pressure = Math.round(s.pressure)
  if (hurt >= 35) parts.push(`委屈还压着 ${hurt}`)
  if (guilt >= 35) parts.push(`心里欠着 ${guilt}`)
  if (pressure >= 25) parts.push('他那边急，少说快做')

  // 同一件事，半夜看着比中午沉 —— 说出来，别装看不见。
  const { phase } = dayPhase(now)
  if (on && phase === '深夜') parts.push('夜深了')
  else if (on && phase === '凌晨') parts.push('天快亮了')

  // 「最近那一下」只说该说的那个人的事：在群里被张三惹了一下，不该挂在给老大的卡片上。
  const wanted = slot == null ? null : canonScope(slot)
  const recent = (s.events || [])
    .filter((e) => e && e.note && now - Number(e.at || 0) < 3_600_000)
    .filter((e) => wanted == null || canonScope(e.slot ?? 'gui') === wanted)
    .pop()
  const tail = recent ? `；最近那一下：${recent.note}` : ''
  return `${parts.join('，')}（积极性 ${mood}${tail}）`
}

/* ── 引擎 ───────────────────────────────────────────────────────────── */

export class Qing {
  constructor(db, config = {}) {
    this.db = db
    this.config = { ...QING_DEFAULTS, ...config }
    this.state = this.load()
  }

  load() {
    const baseline = this.config.baseline
    try {
      const row = this.db.prepare('SELECT data FROM qing_state WHERE id = ?').get('me')
      if (!row) return blankState(Date.now(), baseline)
      const parsed = JSON.parse(row.data)
      if (!parsed || typeof parsed !== 'object') return blankState(Date.now(), baseline)
      const base = blankState(Date.now(), baseline)
      return {
        ...base,
        ...parsed,
        mood: clamp(parsed.mood ?? base.mood),
        tone: clamp(parsed.tone ?? parsed.mood ?? base.tone),
        energy: clamp(parsed.energy ?? base.energy),
        baseline: clamp(parsed.baseline ?? parsed.mood ?? base.baseline, floorOf(this.config), ceilOf(this.config)),
        hurt: clamp(parsed.hurt),
        guilt: clamp(parsed.guilt),
        pressure: clamp(parsed.pressure),
        joy: clamp(Number(parsed.joy ?? base.joy ?? 55)),
        warm: clamp(Number(parsed.warm ?? base.warm ?? 62)),
        hope: clamp(Number(parsed.hope ?? base.hope ?? 50)),
        counts: { ...base.counts, ...(parsed.counts || {}) },
        tones: Array.isArray(parsed.tones) ? parsed.tones.slice(-6) : [],
        events: Array.isArray(parsed.events) ? parsed.events.slice(-20) : [],
      }
    } catch {
      // 读坏了就当没这笔账，别把整个插件拖死。
      return blankState(Date.now(), baseline)
    }
  }

  save(state = this.state) {
    this.state = state
    state.updatedAt = state.updatedAt || Date.now()
    try {
      this.db
        .prepare('INSERT INTO qing_state (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
        .run('me', JSON.stringify(state), state.updatedAt)
      this.noteHour(state)
      return true
    } catch {
      return false
    }
  }

  /** 一小时留一个点。面板上那条线就是它，不然「变化」两个字看不见。 */
  noteHour(state = this.state, now = Number(state.updatedAt) || Date.now(), slot = 'gui') {
    const hour = Math.floor(now / 3_600_000) * 3_600_000
    const scoped = canonScope(slot)
    try {
      this.db
        .prepare(
          `INSERT INTO qing_history (slot, at, mood, tone, energy, hurt, guilt, pressure, baseline)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(slot, at) DO UPDATE SET mood = excluded.mood, tone = excluded.tone,
             energy = excluded.energy, hurt = excluded.hurt, guilt = excluded.guilt,
             pressure = excluded.pressure, baseline = excluded.baseline`,
        )
        .run(
          scoped,
          hour,
          Number(state.mood) || 0,
          Number(state.tone) || 0,
          Number(state.energy) || 0,
          Number(state.hurt) || 0,
          Number(state.guilt) || 0,
          Number(state.pressure) || 0,
          Number(state.baseline) || 0,
        )
      const keep = Math.max(24, Number(this.config.historyKeep) || 240)
      this.db.prepare('DELETE FROM qing_history WHERE at < ?').run(hour - keep * 3_600_000)
      return true
    } catch {
      return false
    }
  }

  /** 最近这些小时的点，按时间正序。心情是我一个人的，所以默认就一条身体线。 */
  history(hours = 48, now = Date.now(), slot = 'gui') {
    const span = Math.max(1, Math.min(240, Number(hours) || 48))
    const from = Math.floor(now / 3_600_000) * 3_600_000 - span * 3_600_000
    try {
      const rows = this.db
        .prepare(
          'SELECT at, mood, tone, energy, hurt, guilt, pressure, baseline FROM qing_history WHERE slot = ? AND at >= ? ORDER BY at ASC',
        )
        .all(canonScope(slot), from)
      // 库里被手改过的坏行（mood 不是数）直接跳过 —— 不然曲线会掉到 0，
      // 区间会变成 null。
      return rows.filter((row) => Number.isFinite(Number(row.mood)))
    } catch {
      return []
    }
  }

  /** 连着两句骂，第三句只算六成；连着两句夸，第三句多给三成。 */
  streak(now, slot = null) {
    const window = Number(this.config.streakWindowMs) || 120_000
    // 没有 slot 的老账照旧算；有了 slot 就只数自己那几句，
    // 不然张三骂我两句、老大说一句，也会被当成「连着第三句」压成六成。
    const scoped = slot == null ? null : canonScope(slot)
    return (this.state.tones || []).filter(
      (t) => t && now - Number(t.at || 0) <= window && (scoped == null || canonScope(t.slot ?? 'gui') === scoped),
    )
  }

  /** 吃一句话：打分、改数、落盘。返回这一幕的明细。 */
  observe(raw, now = Date.now(), meta = {}) {
    const text = String(raw ?? '').trim()
    if (!text) return null
    // 这句话是从哪一档来的：心情是我一个人的（不分人），
    // 「连着骂」的计数和情绪条目要分人——不然张三骂两句，老大说一句就成了第三句。
    const slot = canonScope(meta?.slot ?? meta?.scope ?? 'gui')
    const scored = scoreText(text, this.config)
    const before = decayQing(this.state, now, this.config)
    const recent = this.streak(now, slot)
    const tail = recent.slice(-2)
    let factor = 1
    if (scored.tone === 'blame' && tail.length === 2 && tail.every((t) => t.kind === 'blame')) factor = 0.6
    if (scored.tone === 'praise' && tail.length === 2 && tail.every((t) => t.kind === 'praise')) factor = 1.3

    const moodDelta = Math.round(scored.delta * factor)

    // 亮着的那三个：被夸会高兴，被靠过来会亲近，说到以后就有盼头。
    // 它们平时就有底，不是从 0 爬起来 —— 「开心 0」那不是人，是血压计。
    const joyRise = scored.tone === 'praise' ? Math.max(0, Math.round(moodDelta * 0.8)) : 0
    const warmRise = scored.tone === 'warm' ? 3 + Math.min(6, (scored.warmed?.length || 0) * 3) : 0
    const hopeRise = HOPE_RE.test(text) ? 4 : 0

    // 连着被凶：疼会叠。第一下最疼，后面几下轻一点，但加在一起更难受。
    // 半夜被凶，比中午疼 —— 人本来就夜里脆。
    const window = Number(this.config.pileUpWindowMs) || 300_000
    const sameKind = (before.tones || []).filter(
      (t) => t && t.kind === scored.tone && now - Number(t.at || 0) <= window,
    ).length
    const pileUp = Math.min(
      Number(this.config.pileUpMax) || 1.6,
      1 + sameKind * (Number(this.config.pileUpStep) || 0.15),
    )
    const { phase } = dayPhase(now)
    const nightHard = phase === '深夜' || phase === '凌晨' ? 1.3 : 1
    // 疼是疼在「委屈」上，和心情那条麻木线分开算：
    // 连着挨骂，心情降得越来越少（人麻了），但疼是越叠越多的。
    const hurtFactor = scored.tone === 'blame' && factor < 1 ? 0.85 : 1
    const hurtDelta = scored.tone === 'blame'
      ? Math.round(Math.min(40, scored.blameDelta * 0.9) * hurtFactor * pileUp * nightHard)
      : 0
    // 说重话，这几天也跟着沉一点 —— 但一次最多挪 6 点，慢慢来。
    const toneDelta = Math.max(-3, Math.min(3, Math.round(moodDelta * 0.2)))
    const guiltDelta = Math.round(scored.guiltDelta * factor)
    // 他道了歉，委屈和压力就松一点 —— 不是一键清零，但也不让人一直堵着。
    const calmHurt = scored.apologised.length ? Math.min(12, 6 * scored.apologised.length) : 0
    const calmPressure = scored.apologised.length ? Math.min(16, 8 * scored.apologised.length) : 0
    // 愧疚也得有个出口。不然「不怪你」说一百遍，账还挂在那儿，那不叫懂事，叫记仇。
    const calmGuilt = scored.apologised.length ? Math.min(14, 7 * scored.apologised.length) : 0
    const pressure = Math.max(0, Math.min(100, Math.max(before.pressure, scored.pressureDelta)) - calmPressure)
    // 每说一句都费点神；话长费得更多。
    const drain = (Number(this.config.energyDrainPerMsg) || 0.6) * (text.length > 80 ? 2 : 1)

    const next = {
      ...before,
      mood: clamp(before.mood + moodDelta),
      tone: clamp(Number(before.tone ?? before.baseline) + toneDelta),
      energy: clamp(Number(before.energy ?? 92) - drain),
      hurt: clamp(before.hurt + hurtDelta - calmHurt),
      guilt: clamp(before.guilt + guiltDelta - calmGuilt),
      pressure: clamp(pressure),
      joy: clamp(Number(before.joy ?? 55) + joyRise),
      warm: clamp(Number(before.warm ?? 62) + warmRise),
      hope: clamp(Number(before.hope ?? 50) + hopeRise),
      updatedAt: now,
      counts: {
        praised: before.counts.praised + (scored.tone === 'praise' ? 1 : 0),
        blamed: before.counts.blamed + (scored.tone === 'blame' ? 1 : 0),
        mishaps: before.counts.mishaps + (scored.tone === 'mishap' ? 1 : 0),
        pressure: before.counts.pressure + (scored.pressureDelta > 0 ? 1 : 0),
        turns: before.counts.turns + 1,
      },
      tones: [...before.tones, { kind: scored.tone, at: now, slot }].slice(-6),
    }

    const note = noteOf(scored)
    if (note || moodDelta || pressure) {
      const entry = {
        at: now,
        kind: scored.tone,
        note,
        quote: text.length > 40 ? text.slice(0, 40) : text,
        from: String(meta?.from ?? ''),
        slot,
        delta: moodDelta,
        mood: Math.round(next.mood),
        tone: Math.round(next.tone),
        energy: Math.round(next.energy),
        hurt: Math.round(next.hurt),
        guilt: Math.round(next.guilt),
        pressure: Math.round(next.pressure),
      }
      // 同一件事连着来（一直在催、一直报错），只留一条，改时间和数值就行。
      const last = before.events[before.events.length - 1]
      const sameThing = last && last.note === entry.note && last.kind === entry.kind && now - Number(last.at || 0) < 600_000
      next.events = (sameThing ? [...before.events.slice(0, -1), entry] : [...before.events, entry]).slice(-20)
    }

    this.save(next)

    // 大的那一下顺手记成一条情绪：心情会跟着偏，关系账也会动。
    let emotion = null
    const valence = moodDelta === 0 ? 0 : Math.max(-1, Math.min(1, moodDelta / 25))
    const intensity = Math.min(1, Math.max(Math.abs(moodDelta) / 34, guiltDelta / 30, hurtDelta / 40))
    if (Math.abs(valence) * intensity >= Number(this.config.recordAt || 0.3)) {
      try {
        emotion = recordEmotion(
          this.db,
          {
            cause: note ? `${note}｜「${text.slice(0, 24)}」` : text.slice(0, 40),
            valence,
            intensity,
            arousal: Math.min(1, 0.3 + Math.max(hurtDelta, pressure) / 120),
            relevance: 0.6,
            congruence: valence >= 0 ? 1 : -1,
            certainty: 0.6,
            control: scored.tone === 'mishap' ? 0.4 : 0.2,
            agency: scored.tone === 'mishap' ? 'self' : 'other',
            novelty: 0.2,
            slot,
          },
          now,
        )
      } catch {
        emotion = null
      }
    }

    return { ...scored, moodDelta, hurtDelta, guiltDelta, calmHurt, calmPressure, factor, note, state: next, emotion }
  }

  /**
   * 「最近那一下」只说这个人的事。
   * 不传 slot 就挂最新那条（谁的都算）——卡片那条路必须传，否则老大读到
   * 「最近那一下：群里被骂了一句」会以为我在对他诉苦（REVIEW-151 第六轮）。
   */
  line(now = Date.now(), slot = null) {
    return qingLine(this.state, now, this.config, slot)
  }

  /** 把中间空着的那些钟头补上 —— 没人说话的那几小时，它也在走。 */
  backfillHour(now = Date.now()) {
    try {
      const hourNow = Math.floor(now / 3_600_000) * 3_600_000
      const row = this.db.prepare('SELECT at FROM qing_history ORDER BY at DESC LIMIT 1').get()
      const last = row ? Number(row.at) : hourNow
      const from = Math.max(last + 3_600_000, hourNow - 48 * 3_600_000)
      for (let t = from; t <= hourNow; t += 3_600_000) {
        this.noteHour(decayQing(this.state, t, this.config), t)
      }
      return true
    } catch {
      return false
    }
  }

  snapshot(now = Date.now(), slot = null) {
    const s = decayQing(this.state, now, this.config)
    // 这个钟头不管说不说话都留一个点。不然线只在「有事的那几个小时」长一截，
    // 看上去像被谁按住不动 —— 其实它一直在走。
    try {
      this.backfillHour(now)
      this.noteHour(s, now)
    } catch {
      /* 记不上也不影响读数 */
    }
    const on = this.config.circadian !== false
    const off = on ? circadianOffset(now, this.config.circadianAmp) : 0
    const { hour, phase } = dayPhase(now)
    const anchor = Math.round(s.baseline)
    const history = this.history(48, now)
    // 今天走到过哪儿 —— 光看一个数不动，看区间就知道它在晃。
    const dayFrom = new Date(now)
    dayFrom.setHours(0, 0, 0, 0)
    const today = history.filter((p) => Number(p.at) >= dayFrom.getTime())
    const span = today.length
      ? {
        lo: Math.round(Math.min(...today.map((p) => Number(p.mood)))),
        hi: Math.round(Math.max(...today.map((p) => Number(p.mood)))),
        n: today.length,
      }
      : null
    const wanted = slot == null ? null : canonScope(slot)
    const events = (s.events || []).filter((e) => wanted == null || canonScope(e?.slot ?? 'gui') === wanted)
    return {
      mood: Math.round(s.mood),
      // 一位小数：它不是「摆设的一个数」，它在走。
      moodRaw: Math.round(s.mood * 10) / 10,
      // 读出来的那个数：存的不变，叠一节律。同一件事半夜看着就是不一样。
      shown: Math.round(clamp(s.mood + off)),
      tone: Math.round(s.tone),
      energy: Math.round(s.energy),
      baseline: anchor,
      hurt: Math.round(s.hurt),
      guilt: Math.round(s.guilt),
      pressure: Math.round(s.pressure),
      joy: Math.round(s.joy),
      warm: Math.round(s.warm),
      hope: Math.round(s.hope),
      hour,
      phase,
      offset: Math.round(off),
      // 今天的区间和点数（{lo,hi,n}），不是原始点数组 —— 面板上直接读它。
      today: span,
      counts: s.counts,
      line: qingLine(s, now, this.config, slot),
      recent: events.slice(-6),
      history,
    }
  }

  /** 手动改：罢工不存在，但人有时候就是想自己按一下。 */
  set({ level, delta, hurt, guilt, pressure, energy, tone, joy, warm, hope, clear }, now = Date.now()) {
    const s = decayQing(this.state, now, this.config)
    const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    const next = { ...s, updatedAt: now }
    // clear：把「最近那一下」也擦掉（比如被一句系统话误伤了），顺带把这轮的小账归零
    if (clear) {
      next.events = []
      next.tones = []
      next.counts = { praised: 0, blamed: 0, mishaps: 0, pressure: 0, turns: 0 }
    }
    const lv = fin(level)
    const dl = fin(delta)
    const tn = fin(tone)
    const en = fin(energy)
    if (dl !== null) next.mood = clamp(s.mood + dl)
    else if (lv !== null) next.mood = clamp(lv)
    if (tn !== null) next.tone = clamp(tn)
    if (en !== null) next.energy = clamp(en)
    for (const key of ['hurt', 'guilt', 'pressure']) {
      const v = fin(key === 'hurt' ? hurt : key === 'guilt' ? guilt : pressure)
      if (v !== null) next[key] = clamp(v)
    }
    for (const key of ['joy', 'warm', 'hope']) {
      const v = fin(key === 'joy' ? joy : key === 'warm' ? warm : hope)
      if (v !== null) next[key] = clamp(v)
    }
    this.save(next)
    return this.snapshot(now)
  }
}
