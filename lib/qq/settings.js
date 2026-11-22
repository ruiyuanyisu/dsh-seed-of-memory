// QQ 面板上的设置分两种：
//   1. 改「连接」的（地址、令牌、开关）——必须重连，旧 socket 作废；
//   2. 改「行为」的（白名单、群策略、语气、语音、cwd…）——通道每轮现读 config，
//      改完当场就生效，不需要把连接踢断。
// 这里只挑出第一种，供 index.js 判断「保存之后要不要重建通道」。
export function connectionSignature(cfg = {}) {
  return JSON.stringify([
    Boolean(cfg.enabled),
    String(cfg.wsUrl ?? ''),
    String(cfg.httpUrl ?? ''),
    String(cfg.accessToken ?? ''),
  ])
}

// 语音那档：手写 qq.json 的人可能写成 true/false、on/off、ask。
// 认不出来的一律当 auto，绝不因为一个怪值就变成「每句都说」。
const VOICE_MODES = ['off', 'manual', 'auto', 'always']
const VOICE_ALIAS = {
  on: 'always',
  true: 'always',
  yes: 'always',
  ask: 'manual',
  'on-ask': 'manual',
  false: 'off',
  no: 'off',
  none: 'off',
  '': 'auto',
}

const LIST_KEYS = ['allowPrivate', 'allowGroups', 'groupTopics', 'groupNames']
const BOOL_KEYS = ['enabled', 'autoReply', 'groupRequireAt', 'silentFallback', 'voiceIn']
const NUM_KEYS = [
  'burstMax',
  'burstGapMs',
  'voiceMaxChars',
  'voiceEvery',
  'replyTimeoutMs',
  'maxQueue',
  'groupMinGapSec',
  'groupMaxPerHour',
  'groupMaxPerDay',
  'groupRandomChance',
  'groupQuietStart',
  'groupQuietEnd',
  'groupMentionGapSec',
  'asrTimeoutMs',
  'ttsTimeoutMs',
  'ttsSpeed',
]

function toList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
  }
  // 手写 qq.json 时最容易把数组写成一个字符串：「allowPrivate」: "100000001"。
  // 拆成数组，否则这条白名单会把所有人挡在外面（startsWith/includes 对字符串完全是另一种语义）。
  if (typeof value === 'string') {
    return value
      .split(/[,，、\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  if (typeof value === 'number' && Number.isFinite(value)) return [String(value)]
  return []
}

function toBool(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on', '是', '开'].includes(text)) return true
    if (['false', '0', 'no', 'off', '否', '关', ''].includes(text)) return false
  }
  return undefined
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * 把 qq.json 里手写的怪值收回来。
 *
 * 只动认识的键，别的原样留着。三种最常见的手抖：
 *   - 数组写成字符串（白名单变空/变怪，谁都进不来）
 *   - 布尔写成字符串（"false" 是真值 —— 「只听不回」反而会回）
 *   - 数字写成字符串（间隔/额度在比较时变成了 NaN）
 */
export function normalizeQqConfig(config = {}) {
  const out = { ...(config ?? {}) }
  for (const key of LIST_KEYS) {
    if (key in out) out[key] = toList(out[key])
  }
  for (const key of BOOL_KEYS) {
    if (key in out) {
      const value = toBool(out[key])
      if (value !== undefined) out[key] = value
    }
  }
  for (const key of NUM_KEYS) {
    if (key in out) {
      const value = toNumber(out[key])
      if (value !== undefined) out[key] = value
    }
  }
  if ('voiceOut' in out) {
    const raw = out.voiceOut
    if (typeof raw === 'boolean') out.voiceOut = raw ? 'always' : 'off'
    else if (typeof raw === 'string') {
      const text = raw.trim().toLowerCase()
      const value = VOICE_ALIAS[text] ?? text
      out.voiceOut = VOICE_MODES.includes(value) ? value : 'auto'
    }
  }
  if (out.proactive && typeof out.proactive === 'object') {
    const proactive = { ...out.proactive }
    if ('enabled' in proactive) {
      const value = toBool(proactive.enabled)
      if (value !== undefined) proactive.enabled = value
    }
    if ('voice' in proactive) {
      const value = toBool(proactive.voice)
      if (value !== undefined) proactive.voice = value
    }
    if ('minIntervalHours' in proactive) {
      const value = toNumber(proactive.minIntervalHours)
      if (value !== undefined) proactive.minIntervalHours = value
    }
    if ('maxPerDay' in proactive) {
      const value = toNumber(proactive.maxPerDay)
      if (value !== undefined) proactive.maxPerDay = value
    }
    out.proactive = proactive
  }
  return out
}
