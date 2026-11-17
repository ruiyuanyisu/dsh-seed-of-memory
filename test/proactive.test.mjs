import test from 'node:test'
import assert from 'node:assert/strict'

import { planProactive, proactiveText, inQuietHours, ownerTarget, normalizeOwnerQQ, PROACTIVE_DEFAULTS } from '../lib/qq/proactive.js'

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

test('情绪没劲的时候不硬装开心：想分享这条不开口', () => {
  const plan = planProactive({
    now: NOON,
    mood: { valence: 0.5, arousal: 0.6 },
    affects: [affect('依恋', 0.3)],
    lastUserAt: hourAgo(4),
    qing: { mood: 20, hurt: 0 },
  })
  assert.equal(plan.send, false)

  const fine = planProactive({
    now: NOON,
    mood: { valence: 0.5, arousal: 0.6 },
    affects: [affect('依恋', 0.3)],
    lastUserAt: hourAgo(4),
    qing: { mood: 50, hurt: 0 },
  })
  assert.equal(fine.send, true)
  assert.equal(fine.kind, 'glad')
})

test('情绪很沉的时候更克制：刚找过的那点间隔也拉长一半', () => {
  const base = { now: NOON, mood: { valence: 0.1, arousal: 0.3 }, affects: [affect('依恋', 0.6)] }
  const light = planProactive({ ...base, lastUserAt: hourAgo(7), lastAt: hourAgo(4.5) })
  assert.equal(light.send, true, '心情正常时 4.5 小时就够了')

  const heavy = planProactive({ ...base, lastUserAt: hourAgo(7), lastAt: hourAgo(4.5), qing: { mood: 20, hurt: 0 } })
  assert.equal(heavy.send, false)
  assert.match(heavy.reason, /刚找过/)
})

test('心里欠着的时候，不是撒气，是想问一句', () => {
  const plan = planProactive({
    now: NOON,
    mood: { valence: 0.1, arousal: 0.3 },
    affects: [affect('依恋', 0.6)],
    lastUserAt: hourAgo(5),
    qing: { mood: 45, hurt: 45 },
  })
  assert.equal(plan.send, true)
  assert.equal(plan.kind, 'miss')
  assert.match(plan.reason, /堵/)

  const text = proactiveText('miss', { qing: { hurt: 45 } })
  assert.match(text, /闷/)
})

test('默认值保守：4 小时内最多一次、一天最多 3 次', () => {  assert.equal(PROACTIVE_DEFAULTS.minIntervalHours, 4)
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

test('长记忆不硬切在句子中间，也不出现「…。。」', () => {
  const memory = 'D:\\work 盘是 exFAT（THUNDEROBOT USB 确认），所以他一直想换一块更稳的盘，但暂时不想折腾。'
  const text = proactiveText('miss', { memory })
  assert.ok(text.includes('…'))
  assert.doesNotMatch(text, /…。/)
})

test('主人 QQ 优先，没填才用自定义对象', () => {  assert.equal(ownerTarget({ ownerQQ: '100000001' }), 'private:100000001')
  assert.equal(ownerTarget({ ownerQQ: ' 100000001 ', target: 'group:123456' }), 'private:100000001')
  assert.equal(ownerTarget({ ownerQQ: '', target: 'private:10001' }), 'private:10001')
  assert.equal(ownerTarget({ ownerQQ: 'abc', target: '' }), '')
  assert.equal(ownerTarget({}), '')
})

test('QQ 号里的空格、横线会被滤掉，太短或太长当没填', () => {
  assert.equal(normalizeOwnerQQ(' 100 0000 01 '), '100000001')
  assert.equal(normalizeOwnerQQ('100-0000-01'), '100000001')
  assert.equal(normalizeOwnerQQ('1234'), '')
  assert.equal(normalizeOwnerQQ('1234567890123'), '')
  assert.equal(normalizeOwnerQQ('qq100000001'), '100000001')
  assert.equal(normalizeOwnerQQ(null), '')
})

