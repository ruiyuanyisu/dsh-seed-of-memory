import test from 'node:test'
import assert from 'node:assert/strict'

import { planProactive, proactiveText, inQuietHours, PROACTIVE_DEFAULTS } from '../lib/qq/proactive.js'

const NOON = new Date(2026, 10, 13, 14, 0, 0).getTime()
const hourAgo = (h) => NOON - h * 3_600_000
const affect = (kind, strength) => ({ kind, strength })

test('没开启时不说话', () => {
  const plan = planProactive({ now: NOON, config: { enabled: false } })
  assert.equal(plan.send, false)
  assert.equal(plan.reason, '未开启')
})

test('安静时段不说话', () => {
  const midnight = new Date(2026, 10, 13, 23, 30, 0).getTime()
  const plan = planProactive({ now: midnight })
  assert.equal(plan.send, false)
  assert.equal(inQuietHours(0, 23, 8), true)
  assert.equal(inQuietHours(10, 23, 8), false)
})

test('当日上限与冷却', () => {
  const capped = planProactive({ now: NOON, dayCount: 3 })
  assert.equal(capped.send, false)
  const cooling = planProactive({ now: NOON, lastAt: hourAgo(1) })
  assert.equal(cooling.send, false)
  assert.match(cooling.reason, /刚找过/)
})

test('心情偏负、又有点被搅动 → 担心', () => {
  const plan = planProactive({ now: NOON, mood: { valence: -0.3, arousal: 0.6 } })
  assert.equal(plan.send, true)
  assert.equal(plan.kind, 'worry')
})

test('依恋高、好几个小时没说话 → 想他', () => {
  const plan = planProactive({
    now: NOON,
    mood: { valence: 0.1, arousal: 0.3 },
    affects: [affect('依恋', 0.6)],
    lastUserAt: hourAgo(7),
  })
  assert.equal(plan.send, true)
  assert.equal(plan.kind, 'miss')
})

test('太久没说话 → 有点空', () => {
  const plan = planProactive({
    now: NOON,
    mood: { valence: 0.1, arousal: 0.3 },
    affects: [affect('依恋', 0.3), affect('信任', 0.5)],
    lastUserAt: hourAgo(13),
  })
  assert.equal(plan.send, true)
  assert.equal(plan.kind, 'lonely')
})

test('心情好、也有一阵没说话 → 想分享', () => {
  const plan = planProactive({
    now: NOON,
    mood: { valence: 0.5, arousal: 0.6 },
    affects: [affect('依恋', 0.3)],
    lastUserAt: hourAgo(4),
  })
  assert.equal(plan.send, true)
  assert.equal(plan.kind, 'glad')
})

test('默认值保守：4 小时内最多一次、一天最多 3 次', () => {
  assert.equal(PROACTIVE_DEFAULTS.minIntervalHours, 4)
  assert.equal(PROACTIVE_DEFAULTS.maxPerDay, 3)
  assert.equal(PROACTIVE_DEFAULTS.target, '')
})

test('不知道上次说话时间时，不假装很久没说话', () => {
  const plan = planProactive({
    now: NOON,
    mood: { valence: 0.1, arousal: 0.3 },
    affects: [affect('依恋', 0.6)],
  })
  assert.equal(plan.hoursSinceUser, null)
  assert.equal(plan.send, false)
  assert.doesNotMatch(plan.reason, /太久|想他/)
})

test('文案带一点具体的事，且四种都不一样', () => {
  const texts = ['worry', 'miss', 'lonely', 'glad'].map((kind) =>
    proactiveText(kind, { memory: '他说过周末想去山里', name: '你' }),
  )
  for (const text of texts) assert.ok(text.length > 0 && text.length < 200)
  assert.match(texts[1], /山里/)
  assert.equal(new Set(texts).size, 4)
  assert.equal(proactiveText('none'), '')
})
