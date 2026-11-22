import test from 'node:test'
import assert from 'node:assert/strict'

import { planProactive, proactiveText, inQuietHours, ownerTarget, normalizeOwnerQQ, PROACTIVE_DEFAULTS, cleanSeed, similarity, isRepeat, composeProactive, composeCandidates } from '../lib/qq/proactive.js'

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
  const memory = '他说周末想去山里走走，最好是那种没有信号的地方，手机扔在包里一整天都别响。'
  const text = proactiveText('miss', { memory })
  assert.ok(text.includes('…'))
  assert.doesNotMatch(text, /…。/)
})

test('引子先洗干净：日期、代码路径、命令都不说出口', () => {
  assert.equal(cleanSeed('2026-11-13 Seed of Memory 1.0.0 正式发布'), 'Seed of Memory 1.0.0 正式发布')
  assert.equal(cleanSeed('他说：周末想去山里'), '周末想去山里')
  assert.equal(cleanSeed('E:\\Carys 盘是 exFAT'), '')
  assert.equal(cleanSeed('api_v2.py 加 _carys_trim_silence'), '')
  assert.equal(cleanSeed('npm publish 走 registry'), '')
  assert.equal(cleanSeed('   '), '')
  // 洗不干净时也只说一句普通的，不把代码念出来
  const text = proactiveText('miss', { memory: 'lib/index.js 里 proactiveTick 改了' })
  assert.doesNotMatch(text, /lib\/index\.js|proactiveTick/)
})

test('同一类话有六种说法：不会每次一个腔调', () => {
  const seen = new Set()
  for (let salt = 0; salt < 6; salt++) seen.add(proactiveText('miss', { salt }))
  assert.equal(seen.size, 6)
})

test('像到什么程度算重复：同一个意思换个字也算', () => {
  assert.equal(similarity('有点想你。', '有点想你。'), 1)
  assert.ok(similarity('有点想你，。', '有点想你。') > 0.9)
  assert.ok(similarity('有点想你。', '今天心情不错。') < 0.2)
  const recent = [{ at: 1_000, text: '有点想你。没什么事。' }]
  assert.equal(isRepeat('有点想你。没什么事！', recent, { now: 2_000 }), true)
  assert.equal(isRepeat('今天心情不错。', recent, { now: 2_000 }), false)
  // 超过 24 小时的不算
  assert.equal(isRepeat('有点想你。没什么事。', recent, { now: 1_000 + 25 * 3_600_000 }), false)
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


test('连着两次不说同一句：第二次换说法', () => {
  const first = composeProactive({ kind: 'miss', salt: 0, now: 1_000, pickSeed: () => '' })
  assert.ok(first.text)
  const recent = [{ at: 1_000, text: first.text, seed: first.seed }]
  const second = composeProactive({ kind: 'miss', salt: 0, now: 2_000, recent, pickSeed: () => '' })
  assert.ok(second.text, '还有别的说法就该说出口')
  assert.notEqual(second.text, first.text)
  assert.ok(similarity(second.text, first.text) < 0.8)
})

test('六种说法全说过了：这一轮干脆不说', () => {
  const said = []
  for (let salt = 0; salt < 6; salt++) said.push({ at: 1_000, text: proactiveText('lonely', { salt }), seed: '' })
  const again = composeProactive({ kind: 'lonely', salt: 0, now: 2_000, recent: said, pickSeed: () => '' })
  assert.equal(again.text, '')
})

test('引子用过就不再拎：挑引子的人看得到「已经用过的」', () => {
  const seen = []
  const out = composeProactive({
    kind: 'miss',
    salt: 0,
    now: 1_000,
    recent: [{ at: 900, text: '不一样的一句', seed: '旧的引子' }],
    pickSeed: (used) => {
      seen.push([...used])
      return '新的引子'
    },
  })
  assert.deepEqual(seen[0], ['旧的引子'])
  assert.match(out.text, /新的引子/)
})

test('候选带着引子的来历：什么时候记的、在哪一档', () => {
  const list = composeCandidates({
    kind: 'miss',
    salt: 0,
    now: 1_000,
    attempts: 2,
    pickSeed: () => ({ text: '他答应寒假回家讲故事', at: 12_345, scope: 'gui' }),
  })
  assert.ok(list.length >= 1)
  assert.equal(list[0].seed, '他答应寒假回家讲故事')
  assert.equal(list[0].seedAt, 12_345)
  assert.equal(list[0].seedScope, 'gui')
})

test('候选里不会有两句一模一样的', () => {
  const list = composeCandidates({ kind: 'miss', salt: 0, now: 1_000, attempts: 6, pickSeed: () => '' })
  const texts = list.map((row) => row.text)
  assert.equal(new Set(texts).size, texts.length)
})
