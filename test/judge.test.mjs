import test from 'node:test'
import assert from 'node:assert/strict'

import { judgeUtterance, pickBest, explainVerdict, JUDGE_DEFAULTS } from '../lib/qq/judge.js'

// 2026-11-22 14:00（本地时间）——不落在安静时段
const NOON = new Date(2026, 10, 22, 14, 0, 0).getTime()
const hoursAgo = (h) => NOON - h * 3_600_000
const daysAgo = (d) => NOON - d * 86_400_000

const good = {
  text: '有点想你。没什么事。',
  kind: 'miss',
  seed: '他答应寒假回家讲故事',
  seedAt: daysAgo(1),
  seedScope: 'gui',
  scope: 'gui',
  now: NOON,
  lastUserAt: hoursAgo(8),
  hoursSinceUser: 8,
}

test('一句想他、有具体的事、隔了八小时：该说', () => {
  const v = judgeUtterance(good)
  assert.equal(v.speak, true)
  assert.ok(v.score >= JUDGE_DEFAULTS.minScore, `score=${v.score}`)
  assert.equal(v.reason, '说')
})

test('半夜不开口', () => {
  const v = judgeUtterance({ ...good, now: new Date(2026, 10, 22, 3, 0, 0).getTime() })
  assert.equal(v.speak, false)
  assert.equal(v.reason, '安静时段')
})

test('今天已经说得够多了', () => {
  const v = judgeUtterance({ ...good, dayCount: 5 })
  assert.equal(v.speak, false)
  assert.equal(v.reason, '今天说得够多了')
})

test('刚说不久就别再追一句', () => {
  const v = judgeUtterance({ ...good, lastAt: NOON - 10 * 60_000 })
  assert.equal(v.speak, false)
  assert.equal(v.reason, '刚说不久')
})

test('这话刚说过就不说', () => {
  const v = judgeUtterance({ ...good, recent: [{ at: hoursAgo(2), text: '有点想你。没什么事。' }] })
  assert.equal(v.speak, false)
  assert.equal(v.reason, '这话刚说过')
})

test('别人的事不能当引子讲给老大', () => {
  const v = judgeUtterance({ ...good, seedScope: 'qq:10001', scope: 'gui' })
  assert.equal(v.speak, false)
  assert.equal(v.reason, '引子来自别人的档')
})

test('播报腔重罚：把记忆当进度念，就不说', () => {
  const v = judgeUtterance({
    ...good,
    kind: 'glad',
    text: '今天有件小事让我挺开心：Seed of Memory 正式发布，跟你说一声。',
    seed: 'Seed of Memory 1.0.0',
  })
  assert.equal(v.speak, false)
  const broadcast = v.gates.find((g) => g.id === 'broadcast')
  assert.ok(broadcast.value < 0.5)
})

test('心里不轻松就别硬装开心', () => {
  const text = '今天心情不错。跟你说一声。'
  const happy = judgeUtterance({ ...good, kind: 'glad', text, seed: '', seedAt: 0, qing: { mood: 70 } })
  const heavy = judgeUtterance({ ...good, kind: 'glad', text, seed: '', seedAt: 0, qing: { mood: 30 } })
  assert.equal(happy.speak, true)
  assert.equal(heavy.speak, false)
  assert.ok(happy.score > heavy.score)
})

test('陈年旧闻拿去分享，分数比新鲜的低', () => {
  const text = '刚想到一件事：他答应寒假回家讲故事。心情好，跟你说一声。'
  const fresh = judgeUtterance({ ...good, kind: 'glad', text, seedAt: daysAgo(1) })
  const stale = judgeUtterance({ ...good, kind: 'glad', text, seedAt: daysAgo(60) })
  assert.ok(fresh.score > stale.score, `${fresh.score} vs ${stale.score}`)
})

test('留了话头的比自顾自说完的分数高', () => {
  const plain = judgeUtterance({ ...good, text: '有点想你。' })
  const hooked = judgeUtterance({ ...good, text: '有点想你。你在干嘛呀。' })
  assert.ok(hooked.score > plain.score)
})

test('空话不说', () => {
  const v = judgeUtterance({ ...good, text: '' })
  assert.equal(v.speak, false)
  assert.equal(v.reason, '没有能出口的话')
})

test('pickBest：宁缺勿滥，全不合格就不说', () => {
  const out = pickBest(
    [
      { text: '今天有件小事让我挺开心：Seed of Memory 正式发布，跟你说一声。', seed: 'Seed of Memory 1.0.0', seedAt: daysAgo(1), seedScope: 'gui' },
      { text: '正式发布，已上线，跟你说一声。', seed: '', seedAt: 0, seedScope: '' },
    ],
    good,
  )
  assert.equal(out.chosen, null)
  assert.equal(out.verdict.speak, false)
  assert.equal(out.all.length, 2)
})

test('pickBest：几个候选里挑最该说的那个', () => {
  const out = pickBest(
    [
      { text: '有点想你。', seed: '', seedAt: 0, seedScope: '' },
      { text: '有点想你。你在干嘛呀。', seed: '', seedAt: 0, seedScope: '' },
    ],
    good,
  )
  assert.ok(out.chosen)
  assert.equal(out.chosen.text, '有点想你。你在干嘛呀。')
})

test('explainVerdict：不说时带原因，说时带分数', () => {
  assert.match(explainVerdict({ speak: false, score: 0.2, reason: '安静时段', gates: [] }), /不说（安静时段）/)
  assert.match(explainVerdict({ speak: true, score: 0.81, reason: '说', gates: [{ soft: true, value: 0.9, note: '留了话头' }] }), /说（0\.81）·留了话头/)
})
