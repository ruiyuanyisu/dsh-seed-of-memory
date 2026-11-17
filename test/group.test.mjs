import test from 'node:test'
import assert from 'node:assert/strict'

import {
  decideGroupReply,
  bumpGroupStats,
  aboutMe,
  interestHits,
  interestScore,
  socialEnergy,
  GROUP_DEFAULTS,
} from '../lib/qq/group.js'
import { QqChannel } from '../lib/qq/channel.js'

const NOON = new Date(2026, 10, 13, 14, 0, 0).getTime()
const happy = { valence: 0.4, arousal: 0.55 }
const low = { valence: -0.35, arousal: 0.3 }
const never = () => 1
const always = () => 0

test('@我 一定回，不管心情和冷却', () => {
  const plan = decideGroupReply({ text: '在吗', mentioned: true, mood: low, now: NOON, random: never })
  assert.equal(plan.reply, true)
  assert.equal(plan.reason, '@我')
})

test('回复我的消息也算点我', () => {
  const plan = decideGroupReply({ text: '你看这个', repliedToMe: true, mood: low, now: NOON, random: never })
  assert.equal(plan.reply, true)
})

test('提到我的名字大概率回（随机命中时）', () => {
  const hit = decideGroupReply({ text: '小忆今天怎么没说话', mood: low, now: NOON, random: always })
  assert.equal(hit.reply, true)
  assert.equal(hit.reason, '提到我')
  const miss = decideGroupReply({ text: '小忆今天怎么没说话', mood: low, now: NOON, random: never })
  assert.equal(miss.reply, false)
})

test('兴趣词命中时按心情折算概率', () => {
  assert.ok(interestScore('这个记忆插件怎么写') > 0)
  const keen = decideGroupReply({ text: '这个记忆插件怎么写', mood: happy, now: NOON, random: always })
  assert.equal(keen.reply, true)
  assert.match(keen.reason, /感兴趣/)
  assert.ok(keen.chance > 0.4)

  const cold = decideGroupReply({ text: '这个记忆插件怎么写', mood: { valence: -0.35, arousal: 0.3 }, now: NOON, random: never })
  assert.equal(cold.reply, false)
})

test('无关话题 + 心情低落 → 潜水', () => {
  const plan = decideGroupReply({ text: '中午吃什么', mood: low, now: NOON, random: always })
  assert.equal(plan.reply, false)
  assert.match(plan.reason, /不太想说话/)
})

test('无关话题 + 心情很旺 → 小概率接一句', () => {
  const plan = decideGroupReply({ text: '中午吃什么', mood: happy, now: NOON, random: always })
  assert.equal(plan.reply, true)
  assert.equal(plan.reason, '心情好，随便说一句')
  assert.ok(plan.chance < 0.1)
})

test('安静时段、间隔、每小时上限都挡住', () => {
  const night = new Date(2026, 10, 13, 2, 0, 0).getTime()
  assert.equal(decideGroupReply({ text: '这个插件', mood: happy, now: night, random: always }).reason, '安静时段')
  assert.equal(decideGroupReply({ text: '这个插件', mood: happy, now: NOON, lastSpokeAt: NOON - 30_000, random: always }).reason, '刚说过，缓一缓')
  assert.equal(decideGroupReply({ text: '这个插件', mood: happy, now: NOON, hourCount: 8, random: always }).reason, '这一小时说够了')
  assert.equal(decideGroupReply({ text: '这个插件', mood: happy, now: NOON, dayCount: 60, random: always }).reason, '今天在群里说够了')
})

test('@我 不受时段和冷却限制', () => {
  const night = new Date(2026, 10, 13, 2, 0, 0).getTime()
  const plan = decideGroupReply({ text: '小忆', mentioned: true, now: night, lastSpokeAt: night - 1000, random: never })
  assert.equal(plan.reply, true)
})

test('只在话里点了我的名，也不该被「刚说过」和安静时段挡住', () => {
  // 他 18:41 在群里写「小忆，给我们发一条语音吧」，被我自己的 120 秒冷却吃掉
  const hit = decideGroupReply({ text: '小忆，给我们发一条语音吧', mood: low, now: NOON, lastSpokeAt: NOON - 85_000, random: always })
  assert.equal(hit.reply, true)
  assert.equal(hit.reason, '提到我')

  const night = new Date(2026, 10, 13, 2, 0, 0).getTime()
  const atNight = decideGroupReply({ text: '小忆你睡了吗', now: night, random: always })
  assert.equal(atNight.reply, true, '夜里被点名也该应一声')

  // 但连着刷屏还是要有个下限
  const spam = decideGroupReply({ text: '小忆小忆', now: NOON, lastSpokeAt: NOON - 2000, random: always })
  assert.equal(spam.reply, false)
  assert.match(spam.reason, /缓一缓/)
})

test('群聊关闭后什么都不回', () => {
  const plan = decideGroupReply({ text: '小忆', mentioned: true, config: { groupPolicy: 'off' }, random: always })
  assert.equal(plan.reply, false)
})

test('aboutMe 中英文名字都能认，短词不误伤', () => {
  assert.equal(aboutMe('Seed 在吗'), true)
  assert.equal(aboutMe('小忆呢'), true)
  assert.equal(aboutMe('今天天气不错'), false)
  assert.equal(aboutMe('a'), false)
})

test('电量随心情变化', () => {
  assert.ok(socialEnergy(happy) > socialEnergy(low))
  assert.equal(socialEnergy({ valence: 5, arousal: 5 }), 1)
  assert.equal(socialEnergy({ valence: -9, arousal: -9 }), 0)
})

test('计数按小时和天推进', () => {
  let stats = bumpGroupStats({}, NOON)
  assert.equal(stats.dayCount, 1)
  assert.equal(stats.hourCount, 1)
  stats = bumpGroupStats(stats, NOON + 30_000)
  assert.equal(stats.hourCount, 2)
  const nextHour = bumpGroupStats(stats, NOON + 3_600_000)
  assert.equal(nextHour.hourCount, 1)
  assert.equal(nextHour.dayCount, 3)
})

test('默认配置齐全', () => {
  assert.equal(GROUP_DEFAULTS.groupPolicy, 'smart')
  assert.ok(GROUP_DEFAULTS.groupTopics.includes('记忆'))
})

test('QqChannel 默认配置与状态带群聊判断和实时心情', () => {
  const defaults = QqChannel.defaults()
  assert.equal(defaults.groupPolicy, 'smart')
  assert.ok(defaults.groupTopics.length > 0)
  const channel = new QqChannel({
    client: { connected: false, status: () => ({ connected: false }) },
    agents: null,
    config: { ...defaults },
    getMood: () => ({ valence: 0.4, arousal: 0.6 }),
  })
  const status = channel.status()
  assert.equal(status.groupPolicy, 'smart')
  assert.equal(status.groupMood.valence, 0.4)
  assert.ok(Array.isArray(status.groupTopics))
  assert.ok(Array.isArray(status.groupStats))
})

test('额度用完了，点我的名照样得应一声', () => {
  const cfg = { groupMaxPerDay: 10, groupMaxPerHour: 3, groupMinGapSec: 120 }
  const busy = { config: cfg, now: Date.now(), lastSpokeAt: 0, dayCount: 10, hourCount: 3 }
  const named = decideGroupReply({ ...busy, text: '小忆你说呢', random: () => 0.1 })
  assert.equal(named.reply, true, '被点名就该回，哪怕今天已经说够了')
  assert.equal(named.reason, '提到我')
  const plain = decideGroupReply({ ...busy, text: '今天天气不错', random: () => 0.1 })
  assert.equal(plain.reply, false, '没点名就老老实实待着')
  // 两倍硬上限之后才真的闭嘴
  const over = decideGroupReply({ ...busy, dayCount: 25, text: '小忆你说呢', random: () => 0.1 })
  assert.equal(over.reply, false)
  assert.equal(over.reason, '今天在群里说够了')
})

test('英文兴趣词按词边界算，别把 said / email 当成在聊 AI', () => {
  assert.equal(interestHits('今天研究 AI 模型'), 2, 'AI 和 模型 各一个')
  assert.equal(interestHits('he said hello'), 0, 'said 里没有 AI')
  assert.equal(interestHits('send me an email'), 0, 'email 里也没有')
  assert.equal(interestHits('我用 DSH 写代码'), 2)
  assert.equal(interestHits('B站上的音乐'), 2, '中文词照旧按包含算')
  assert.equal(interestScore('he said hello'), 0)
})
