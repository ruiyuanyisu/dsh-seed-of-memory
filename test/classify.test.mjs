import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyText, kindOf, promotionScore, explainScore, TIER_OF_LAYER } from '../lib/classify.js'

test('层默认映射正确', () => {
  assert.equal(TIER_OF_LAYER.persona, 'long')
  assert.equal(TIER_OF_LAYER.semantic, 'long')
  assert.equal(TIER_OF_LAYER.episodic, 'short')
  assert.equal(TIER_OF_LAYER.buffer, 'working')
})

test('kindOf 能分辨身份、偏好、计划、事件、事实', () => {
  assert.equal(kindOf('我的名字叫阿鱼'), 'identity')
  assert.equal(kindOf('我喜欢夜里听雨'), 'preference')
  assert.equal(kindOf('打算明天把索引做完'), 'plan')
  assert.equal(kindOf('今天她说要早点睡'), 'event')
  assert.equal(kindOf('Seed of Memory 用的是 SQLite'), 'fact')
})

test('明说的长期线索盖过层默认值', () => {
  const result = classifyText('记住，她怕冷', { layer: 'episodic' })
  assert.equal(result.tier, 'long')
  assert.ok(result.reasons.includes('cue:permanent'))
})

test('时间性的话落在短期', () => {
  const result = classifyText('今天下午有点困', { layer: 'semantic' })
  assert.equal(result.tier, 'short')
  assert.ok(result.reasons.includes('cue:temporal'))
})

test('buffer 默认是工作记忆，身份类再抬到长期', () => {
  assert.equal(classifyText('在改索引', { layer: 'buffer' }).tier, 'working')
  assert.equal(classifyText('刚才在改索引', { layer: 'buffer' }).tier, 'short')
  assert.equal(classifyText('我叫阿鱼', { layer: 'buffer' }).tier, 'long')
})

test('新鲜短期记忆不过门槛', () => {
  const result = promotionScore({ text: '今天下午有点困', importance: 0.4, recalls: 0, session_count: 1 })
  assert.ok(result.score < result.threshold)
})

test('跨会话 + 多次召回能过门槛，且门槛因倍速下降', () => {
  const result = promotionScore(
    { text: '她怕冷，冬天总穿很厚的袜子', importance: 0.7, recalls: 4, session_count: 3 },
    { emotion: 0.6 },
  )
  assert.ok(result.score >= result.threshold, `${result.score} < ${result.threshold}`)
  assert.ok(result.threshold < 0.6)
  assert.match(explainScore(result), /跨会话/)
})

test('不看情绪正负，只看强度（传入的是绝对值）', () => {
  const negative = promotionScore({ text: '她那次哭得很厉害', importance: 0.6, recalls: 2, session_count: 2 }, { emotion: 0.9 })
  assert.ok(negative.parts.affect > 0.8)
})
