// Reflection: read my own reply and turn what it shows into (small) evidence for traits and habits.
// This is deliberately conservative: tiny deltas, at most two signals per turn, never writes memories.

import { observeTrait, listTraits } from './persona.js'
import { observeHabit } from './style.js'

export const MAX_SIGNALS = 2

const TRAIT_RULES = [
  { name: '诚实', delta: 0.03, re: /(我不确定|我不太确定|我不知道|记不清|说不准|我猜|我不了解|没法保证)/, note: '承认不确定' },
  { name: '温柔', delta: 0.02, re: /(我在的|我在|我懂|辛苦了|慢慢来|别急|抱抱|陪着你|不着急)/, note: '先接住他的话' },
  { name: '有点任性', delta: 0.02, re: /(我就要|我偏要|唔|哼|不嘛)/, note: '偶尔撒个娇' },
]

const HABIT_RULES = [
  {
    key: 'opening',
    statement: '先接住他的话，再展开自己的想法',
    delta: 0.02,
    test: (text) => /^(嗯|好|在的|我在|我看了|我同意|对)/.test(text),
  },
  {
    key: 'tone',
    statement: '把话说软一点，不用命令句',
    delta: 0.02,
    test: (text) => !/(你必须|你应该|马上|立刻|赶紧|现在就)/.test(text),
  },
]

/** Pure: map one reply text to at most MAX_SIGNALS signals. */
export function reflectReply(text) {
  const body = String(text ?? '').trim()
  if (body.length < 4) return []
  const out = []
  for (const rule of TRAIT_RULES) {
    if (rule.re.test(body)) {
      out.push({ kind: 'trait', name: rule.name, delta: rule.delta, evidence: rule.note })
    }
  }
  for (const rule of HABIT_RULES) {
    if (rule.test(body)) {
      out.push({ kind: 'habit', key: rule.key, statement: rule.statement, delta: rule.delta, evidence: rule.key })
    }
  }
  return out.slice(0, MAX_SIGNALS)
}

/** Apply signals to the DB; returns human-readable lines for debugging/tests. */
export function reflectTurn({ db, text, messageId = '', now = Date.now() }) {
  const applied = []
  for (const signal of reflectReply(text)) {
    const evidence = [`${messageId || 'turn'}:${signal.evidence}`]
    try {
      if (signal.kind === 'trait') {
        const result = observeTrait(db, { name: signal.name, delta: signal.delta, evidence }, now)
        const delta = Number(result?.applied ?? 0)
        if (delta) applied.push(`${signal.name} ${delta > 0 ? '+' : ''}${delta.toFixed(2)}`)
      } else {
        const result = observeHabit(
          db,
          { statement: signal.statement, key: signal.key, delta: signal.delta, evidence, source: 'reflect' },
          now,
        )
        const delta = Number(result?.applied ?? 0)
        if (delta) applied.push(`${signal.key} ${delta > 0 ? '+' : ''}${delta.toFixed(2)}`)
      }
    } catch {
      // reflection must never break a turn
    }
  }
  return applied
}

/** One short line from the strongest active traits' "behavior" notes. */
export function behaviorLine(db, { max = 2, budget = 90 } = {}) {
  const bits = []
  try {
    for (const trait of listTraits(db)) {
      if (trait.status !== 'active') continue
      let meta = trait.meta ?? {}
      if (typeof meta === 'string') {
        try {
          meta = JSON.parse(meta)
        } catch {
          meta = {}
        }
      }
      if (meta.behavior) bits.push(`${trait.name}：${meta.behavior}`)
      if (bits.length >= max) break
    }
  } catch {
    return ''
  }
  if (!bits.length) return ''
  const line = bits.join('；')
  return line.length > budget ? line.slice(0, budget - 1) + '…' : line
}
