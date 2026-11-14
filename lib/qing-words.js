// 情绪词表。
//
// 数据放在同目录的 qing-words.json 里，这里只负责读进来。
// 为什么不直接写成 JS 常量：插件热重载只重载入口 `index.js`，被 import 的模块
// 在宿主进程里一直是旧的那一份 —— 改词表要重启 DSH 才吃到。改成「每次打分前看一眼
// 文件有没有变」，改词表就不用重启了。
//
// 词表取材自 @Yuk1Na 的 dsh-yinqing（MIT），按 Seed of Memory 的判定顺序整理过。
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DEFAULT_FILE = fileURLToPath(new URL('./qing-words.json', import.meta.url))

// 下面九个是「活绑定」：refreshWords() 重新赋值，import 它们的地方下次读到的就是新的。
export let PRAISE = []
export let SOFT = []
export let BLAME = []
export let MISHAP = []
export let PRESSURE = []
export let NEUTRALISE = []
export let APOLOGY = []
export let WARM = []
export let TIRED = []

let wordsFile = DEFAULT_FILE
let seenMtime = -1
let warnedMtime = -1

function assign(data) {
  PRAISE = Array.isArray(data.PRAISE) ? data.PRAISE : []
  SOFT = Array.isArray(data.SOFT) ? data.SOFT : []
  BLAME = Array.isArray(data.BLAME) ? data.BLAME : []
  MISHAP = Array.isArray(data.MISHAP) ? data.MISHAP : []
  PRESSURE = Array.isArray(data.PRESSURE) ? data.PRESSURE : []
  NEUTRALISE = Array.isArray(data.NEUTRALISE) ? data.NEUTRALISE : []
  APOLOGY = Array.isArray(data.APOLOGY) ? data.APOLOGY : []
  WARM = Array.isArray(data.WARM) ? data.WARM : []
  TIRED = Array.isArray(data.TIRED) ? data.TIRED : []
}

const KEYS = ['PRAISE', 'SOFT', 'BLAME', 'MISHAP', 'PRESSURE', 'NEUTRALISE', 'APOLOGY', 'WARM', 'TIRED']

/**
 * 一张词表收拾干净：只留非空字符串、去掉前后空格和重复项。
 * 统一转小写——打分前文本本来就会转小写，词表里写 `DeepSeek` 也得能命中。
 */
function cleanList(value, { pairs = false } = {}) {
  if (!Array.isArray(value)) return null
  const out = []
  const seen = new Set()
  for (const item of value) {
    if (pairs) {
      if (!Array.isArray(item) || item.length !== 2) continue
      const from = typeof item[0] === 'string' ? item[0].trim().toLowerCase() : ''
      const to = typeof item[1] === 'string' ? item[1].toLowerCase() : ''
      if (!from) continue
      const key = `${from}\u0000${to}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push([from, to])
      continue
    }
    if (typeof item !== 'string') continue
    const word = item.trim().toLowerCase()
    if (!word || seen.has(word)) continue
    seen.add(word)
    out.push(word)
  }
  return out
}

/**
 * 文件改了就把词表换掉；没改就只是一次 statSync。
 * 读坏了（写一半、JSON 手抖、缺表）就留着上一份，不抛。
 * 记事本存成带 BOM 的 UTF-8 也认。
 */
export function refreshWords() {
  let mtime
  try {
    mtime = statSync(wordsFile).mtimeMs
  } catch {
    return false
  }
  if (mtime === seenMtime) return false
  try {
    const text = readFileSync(wordsFile, 'utf8').replace(/^\uFEFF/, '')
    const data = JSON.parse(text)
    if (!data || typeof data !== 'object') throw new Error('不是对象')
    const next = {}
    for (const key of KEYS) {
      if (!(key in data)) throw new Error(`少了 ${key} 这张表`)
      const list = cleanList(data[key], { pairs: key === 'NEUTRALISE' })
      if (!list) throw new Error(`${key} 不是数组`)
      next[key] = list
    }
    // 九张表全被清空，多半是保存时出了岔子，不是想删干净
    if (KEYS.every((key) => next[key].length === 0)) throw new Error('九张表都是空的')
    assign(next)
    seenMtime = mtime
    return true
  } catch (error) {
    // 同一个坏文件只提醒一次，别每说一句话就刷一行
    if (mtime !== warnedMtime) {
      warnedMtime = mtime
      console.warn('[seed-of-memory] 词表读取失败（沿用上一份）：' + (error?.message ?? error))
    }
    return false
  }
}

/** 测试用：换一份词表文件再读。 */
export function __setWordsFile(path) {
  wordsFile = path
  seenMtime = -1
  return refreshWords()
}

export function wordsSnapshot() {
  return { PRAISE, SOFT, BLAME, MISHAP, PRESSURE, NEUTRALISE, APOLOGY, WARM, TIRED }
}

refreshWords()
