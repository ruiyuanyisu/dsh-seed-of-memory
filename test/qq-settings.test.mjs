import test from 'node:test'
import assert from 'node:assert/strict'

import { connectionSignature, normalizeQqConfig } from '../lib/qq/settings.js'

test('连接参数没变就是同一个签名', () => {
  const a = { enabled: true, wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', accessToken: 'x' }
  assert.equal(connectionSignature(a), connectionSignature({ ...a }))
})

test('改白名单、语气、语音这些行为设置，不应该触发重连', () => {
  const base = { enabled: true, wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', accessToken: 'x' }
  const changed = {
    ...base,
    allowPrivate: ['1', '2'],
    allowGroups: ['3'],
    autoReply: false,
    groupPolicy: 'at',
    groupMinGapSec: 30,
    cwd: 'E:\\cz',
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    voiceOut: 'always',
    voiceEvery: 5,
    replyTimeoutMs: 60_000,
    proactive: { enabled: true },
  }
  assert.equal(connectionSignature(base), connectionSignature(changed))
})

test('换地址、换令牌、开关通道，才需要重建', () => {
  const base = { enabled: true, wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', accessToken: 'x' }
  const variants = [
    { ...base, wsUrl: 'ws://127.0.0.1:3002' },
    { ...base, httpUrl: 'http://127.0.0.1:3009' },
    { ...base, accessToken: 'y' },
    { ...base, enabled: false },
  ]
  for (const variant of variants) {
    assert.notEqual(connectionSignature(base), connectionSignature(variant))
  }
})

test('字段缺省也稳，不会因为 undefined 和空串反复重建', () => {
  assert.equal(connectionSignature({}), connectionSignature({ enabled: undefined, wsUrl: undefined }))
  assert.equal(connectionSignature({}), connectionSignature({ enabled: false, wsUrl: '', httpUrl: '', accessToken: '' }))
})

test('手改 qq.json：白名单写成字符串也认，写成 null/数字也不会把所有人挡掉', () => {
  assert.deepEqual(normalizeQqConfig({ allowPrivate: '100000001' }).allowPrivate, ['100000001'])
  assert.deepEqual(normalizeQqConfig({ allowPrivate: '111, 222 333' }).allowPrivate, ['111', '222', '333'])
  assert.deepEqual(normalizeQqConfig({ allowGroups: 200000001 }).allowGroups, ['200000001'])
  assert.deepEqual(normalizeQqConfig({ allowPrivate: null }).allowPrivate, [])
  assert.deepEqual(normalizeQqConfig({ allowPrivate: [' 1 ', ''] }).allowPrivate, ['1'])
})

test('手改 qq.json：布尔写成 "false" 不会被当成真', () => {
  const got = normalizeQqConfig({ autoReply: 'false', enabled: 'no', groupRequireAt: '0', silentFallback: '关', voiceIn: '是' })
  assert.equal(got.autoReply, false)
  assert.equal(got.enabled, false)
  assert.equal(got.groupRequireAt, false)
  assert.equal(got.silentFallback, false)
  assert.equal(got.voiceIn, true)
  // 认不出来的原样留着，别瞎改
  assert.equal(normalizeQqConfig({ autoReply: '也许' }).autoReply, '也许')
})

test('手改 qq.json：数字写成字符串也收回来，怪值不动', () => {
  const got = normalizeQqConfig({ burstGapMs: '900', groupMaxPerDay: '12', groupRandomChance: '0.06', replyTimeoutMs: 'abc' })
  assert.equal(got.burstGapMs, 900)
  assert.equal(got.groupMaxPerDay, 12)
  assert.equal(got.groupRandomChance, 0.06)
  assert.equal(got.replyTimeoutMs, 'abc')
  assert.equal(normalizeQqConfig({ replyTimeoutMs: Number.NaN }).replyTimeoutMs, Number.NaN, 'NaN 不是字符串，原样留着等默认值兜底')
})

test('手改 qq.json：主动消息那一段也收，别的键原样不动', () => {
  const got = normalizeQqConfig({ proactive: { enabled: 'true', voice: 'off', minIntervalHours: '6' }, cwd: 'E:\\cz', 未知键: 42 })
  assert.equal(got.proactive.enabled, true)
  assert.equal(got.proactive.voice, false)
  assert.equal(got.proactive.minIntervalHours, 6)
  assert.equal(got.cwd, 'E:\\cz')
  assert.equal(got.未知键, 42)
  assert.deepEqual(normalizeQqConfig({}).proactive, undefined)
})

test('通道拿到手写的怪配置时，行为按收好的算（白名单字符串不再把人全挡掉）', async () => {
  const { QqChannel } = await import('../lib/qq/channel.js')
  const makeChannel = (config) => {
    const agents = {
      get() {},
      resume: async () => {
        throw new Error('not found')
      },
      create: async () => ({ agent: { followup: async () => {} }, dispose() {} }),
    }
    const client = { connected: true, connects: 1, lastError: '', on() {}, connect() {}, close() {}, call: async () => ({ message_id: 1 }) }
    return new QqChannel({ client, agents, config, logger: {}, history: null })
  }
  const event = {
    post_type: 'message',
    message_type: 'private',
    self_id: 1,
    user_id: 100000001,
    message_id: 7,
    time: Math.floor(Date.now() / 1000),
    message: [{ type: 'text', data: { text: '在吗' } }],
    sender: { user_id: 100000001 },
  }
  // autoReply=false 只为让这条用例不进入需要等回复的那条路；要看的是「有没有被挡」。
  const channel = makeChannel({ allowPrivate: '100000001', allowGroups: [], autoReply: false })
  await channel.start()
  await channel.handleEvent(event)
  const kinds = channel.status().log.map((line) => line.kind)
  channel.stop()
  assert.ok(kinds.includes('observe'), '字符串白名单应该认，不该 deny：' + kinds.join(','))
  assert.ok(!kinds.includes('deny'))

  const off = makeChannel({ allowPrivate: ['100000001'], autoReply: 'false' })
  await off.start()
  await off.handleEvent(event)
  const offKinds = off.status().log.map((line) => line.kind)
  off.stop()
  assert.ok(offKinds.includes('observe'), 'autoReply="false" 应当是只听不回：' + offKinds.join(','))
})
test('手改 qq.json：语音那档写成 true/false/ask 也认得', () => {
  assert.equal(normalizeQqConfig({ voiceOut: false }).voiceOut, 'off')
  assert.equal(normalizeQqConfig({ voiceOut: true }).voiceOut, 'always')
  assert.equal(normalizeQqConfig({ voiceOut: 'on' }).voiceOut, 'always')
  assert.equal(normalizeQqConfig({ voiceOut: 'ask' }).voiceOut, 'manual')
  assert.equal(normalizeQqConfig({ voiceOut: 'MANUAL' }).voiceOut, 'manual')
  // 认不出来的一律当 auto —— 不能因为一个怪值就变成每句都说
  assert.equal(normalizeQqConfig({ voiceOut: '随便写' }).voiceOut, 'auto')
  assert.equal(normalizeQqConfig({ voiceOut: '' }).voiceOut, 'auto')
})
