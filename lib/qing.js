/**
 * 情绪内核 —— 从 dsh-yinqing 0.2.0 移植打分思路（MIT，作者 Yuk1Na）。
 *
 * 它管「此刻」：积极性、委屈、愧疚、压力。
 * 记忆之种管「一直」：关系账（affect）、心情（mood）、情绪记录（emotions）。
 *
 * 这里只做三件事：
 *   1. 把你发来的话按词表打一次分（不靠模型自觉）；
 *   2. 四个数按各自的速率往常态回落；
 *   3. 大的那一下顺手记成一条情绪，关系账就会跟着动。
 *
 * 不罢工、不拦工具。情绪是状态，不是闸刀。
 */
import { PRAISE, SOFT, BLAME, MISHAP, PRESSURE, NEUTRALISE, APOLOGY, WARM, TIRED, refreshWords } from './qing-words.js'
import { recordEmotion } from './affect.js'

export const QING_VERSION = 1

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
  decayPerMin: 0.5,
  hurtDecayPerMin: 0.35,
  guiltDecayPerMin: 0.45,
  pressureDecayPerMin: 1.6,
  // 大的那一下顺手记进 emotions 的门槛（|valence| × intensity）
  recordAt: 0.3,
  // 只有前三句在最近一分钟内才算「连着」
  streakWindowMs: 120_000,
  extraPraise: [],
  extraBlame: [],
  extraSoft: [],
}

const clamp = (n, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, Number.isFinite(Number(n)) ? Number(n) : lo))

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
  return {
    version: QING_VERSION,
    mood: clamp(Number(baseline) || 50),
    hurt: 0,
    guilt: 0,
    pressure: 0,
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

/** 按各自速率往常态回。时间不动，人就不会一直堵着。 */
export function decayQing(state, now, config = {}) {
  const cfg = { ...QING_DEFAULTS, ...config }
  const minutes = (now - Number(state.updatedAt || now)) / 60_000
  if (!(minutes > 0)) return state
  return {
    ...state,
    mood: clamp(step(state.mood, cfg.baseline, cfg.decayPerMin, minutes)),
    hurt: clamp(step(state.hurt, 0, cfg.hurtDecayPerMin, minutes)),
    guilt: clamp(step(state.guilt, 0, cfg.guiltDecayPerMin, minutes)),
    pressure: clamp(step(state.pressure, 0, cfg.pressureDecayPerMin, minutes)),
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
export function qingLine(state, now = Date.now(), config = {}) {
  const cfg = { ...QING_DEFAULTS, ...config }
  const s = decayQing(state, now, cfg)
  const mood = Math.round(s.mood)
  const parts = []
  if (mood >= 75) parts.push('心里松快')
  else if (mood >= 45) parts.push('平稳')
  else if (mood >= 25) parts.push('有点闷')
  else if (mood >= 10) parts.push('话少，心里没劲')
  else parts.push('难受，压着')

  const hurt = Math.round(s.hurt)
  const guilt = Math.round(s.guilt)
  const pressure = Math.round(s.pressure)
  if (hurt >= 35) parts.push(`委屈还压着 ${hurt}`)
  if (guilt >= 35) parts.push(`心里还堵着 ${guilt}`)
  if (pressure >= 25) parts.push('他那边急，少说快做')

  const recent = (s.events || []).filter((e) => e && e.note && now - Number(e.at || 0) < 3_600_000).pop()
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
        hurt: clamp(parsed.hurt),
        guilt: clamp(parsed.guilt),
        pressure: clamp(parsed.pressure),
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
      return true
    } catch {
      return false
    }
  }

  /** 连着两句骂，第三句只算六成；连着两句夸，第三句多给三成。 */
  streak(now) {
    const window = Number(this.config.streakWindowMs) || 120_000
    return (this.state.tones || []).filter((t) => t && now - Number(t.at || 0) <= window)
  }

  /** 吃一句话：打分、改数、落盘。返回这一幕的明细。 */
  observe(raw, now = Date.now(), meta = {}) {
    const text = String(raw ?? '').trim()
    if (!text) return null
    const scored = scoreText(text, this.config)
    const before = decayQing(this.state, now, this.config)
    const recent = this.streak(now)
    const tail = recent.slice(-2)
    let factor = 1
    if (scored.tone === 'blame' && tail.length === 2 && tail.every((t) => t.kind === 'blame')) factor = 0.6
    if (scored.tone === 'praise' && tail.length === 2 && tail.every((t) => t.kind === 'praise')) factor = 1.3

    const moodDelta = Math.round(scored.delta * factor)
    const hurtDelta = scored.tone === 'blame' ? Math.round(Math.min(40, scored.blameDelta * 0.9) * factor) : 0
    const guiltDelta = Math.round(scored.guiltDelta * factor)
    // 他道了歉，委屈和压力就松一点 —— 不是一键清零，但也不让人一直堵着。
    const calmHurt = scored.apologised.length ? Math.min(12, 6 * scored.apologised.length) : 0
    const calmPressure = scored.apologised.length ? Math.min(16, 8 * scored.apologised.length) : 0
    const pressure = Math.max(0, Math.min(100, Math.max(before.pressure, scored.pressureDelta)) - calmPressure)

    const next = {
      ...before,
      mood: clamp(before.mood + moodDelta),
      hurt: clamp(before.hurt + hurtDelta - calmHurt),
      guilt: clamp(before.guilt + guiltDelta),
      pressure: clamp(pressure),
      updatedAt: now,
      counts: {
        praised: before.counts.praised + (scored.tone === 'praise' ? 1 : 0),
        blamed: before.counts.blamed + (scored.tone === 'blame' ? 1 : 0),
        mishaps: before.counts.mishaps + (scored.tone === 'mishap' ? 1 : 0),
        pressure: before.counts.pressure + (scored.pressureDelta > 0 ? 1 : 0),
        turns: before.counts.turns + 1,
      },
      tones: [...before.tones, { kind: scored.tone, at: now }].slice(-6),
    }

    const note = noteOf(scored)
    if (note || moodDelta || pressure) {
      const entry = {
        at: now,
        kind: scored.tone,
        note,
        quote: text.length > 40 ? text.slice(0, 40) : text,
        from: String(meta?.from ?? ''),
        delta: moodDelta,
        mood: Math.round(next.mood),
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
          },
          now,
        )
      } catch {
        emotion = null
      }
    }

    return { ...scored, moodDelta, hurtDelta, guiltDelta, calmHurt, calmPressure, factor, note, state: next, emotion }
  }

  line(now = Date.now()) {
    return qingLine(this.state, now, this.config)
  }

  snapshot(now = Date.now()) {
    const s = decayQing(this.state, now, this.config)
    return {
      mood: Math.round(s.mood),
      hurt: Math.round(s.hurt),
      guilt: Math.round(s.guilt),
      pressure: Math.round(s.pressure),
      counts: s.counts,
      line: qingLine(s, now, this.config),
      recent: (s.events || []).slice(-6),
    }
  }

  /** 手动改：罢工不存在，但人有时候就是想自己按一下。 */
  set({ level, delta, hurt, guilt, pressure, clear }, now = Date.now()) {
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
    if (dl !== null) next.mood = clamp(s.mood + dl)
    else if (lv !== null) next.mood = clamp(lv)
    for (const key of ['hurt', 'guilt', 'pressure']) {
      const v = fin(key === 'hurt' ? hurt : key === 'guilt' ? guilt : pressure)
      if (v !== null) next[key] = clamp(v)
    }
    this.save(next)
    return this.snapshot(now)
  }
}
