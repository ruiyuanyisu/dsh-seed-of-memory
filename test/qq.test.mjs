import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { QqChannel, splitBubbles, voiceFallback, voiceCadence } from '../lib/qq/channel.js'
import { ownerTarget } from '../lib/qq/proactive.js'
import { segmentsOf, textOf, mentionedSelf, fallbackUserMessage, wantsVoice } from '../lib/qq/message.js'

class FakeClient extends EventEmitter {
  constructor() {
    super()
    this.connected = false
    this.calls = []
    this.selfId = '10000'
  }

  status() {
    return { connected: this.connected, selfId: this.selfId }
  }

  connect() {
    this.connected = true
  }

  close() {
    this.connected = false
  }

  async call(action, params) {
    this.calls.push({ action, params })
    return { status: 'ok', data: { message_id: this.calls.length } }
  }
}

function fakeAgents({ reply = '好的，我记住了。', failResume = true } = {}) {
  const agents = new Map()
  const created = []
  return {
    created,
    get(id) {
      return agents.get(id) ?? null
    },
    async resume() {
      if (failResume) throw new Error('no session')
      return null
    },
    async create({ sessionId }) {
      const agent = {
        followup(message) {
          created.push({ sessionId, message })
          setTimeout(() => {
            channelRef?.onSessionEvent(
              { header: { id: sessionId } },
              { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } },
            )
            // 一个字都没答上来时，靠 turn/end 收尾
            if (!reply) {
              setTimeout(() => {
                channelRef?.onSessionEvent({ header: { id: sessionId } }, { type: 'turn/end', data: {} })
              }, 5)
            }
          }, 5)
        },
        async whenIdle() {},
      }
      agents.set(sessionId, agent)
      let disposed = false
      return {
        agent,
        dispose() {
          if (disposed) return
          disposed = true
          agents.delete(sessionId)
        },
      }
    },
  }
}

let channelRef = null

function makeChannel({ config = {}, agents, client = new FakeClient(), onLog } = {}) {
  const merged = {
    ...QqChannel.defaults(),
    enabled: true,
    allowPrivate: ['10001'],
    allowGroups: ['123456'],
    ...config,
  }
  const channel = new QqChannel({ client, agents: agents ?? fakeAgents(), config: merged, logger: console, onLog })
  channelRef = channel
  return { channel, client }
}

test('没听懂的时候要说一声：语音转文字失败不等于没收到', () => {
  assert.equal(voiceFallback({ text: '' }), '')
  assert.equal(voiceFallback({ text: '在的' }), '')
  assert.equal(voiceFallback({ text: '', unhearable: true }), 'unavailable')
  assert.equal(voiceFallback({ text: '', asrFailed: true }), 'hear-failed')
  // 有文字时，哪怕语音没转成功，也不用再道歉
  assert.equal(voiceFallback({ text: '顺便说一句', asrFailed: true }), '')
})

test('segmentsOf: array / CQ 字符串', () => {
  const arr = segmentsOf([
    { type: 'at', data: { qq: '10000' } },
    { type: 'text', data: { text: ' 你好' } },
    { type: 'face', data: { id: '14' } },
  ])
  assert.equal(arr.length, 3)
  assert.equal(textOf(arr), '你好')

  const cq = segmentsOf('[CQ:at,qq=10000] 帮我记住 [CQ:face,id=14]')
  assert.equal(cq[0].type, 'at')
  assert.equal(cq[1].type, 'text')
  assert.equal(textOf(cq), '帮我记住')
  assert.equal(cq[2].type, 'face')
})

test('mentionedSelf 只在 at 自己时为真', () => {
  const yes = segmentsOf([{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: 'hi' } }])
  const no = segmentsOf([{ type: 'at', data: { qq: '20000' } }, { type: 'text', data: { text: 'hi' } }])
  assert.equal(mentionedSelf(yes, '10000'), true)
  assert.equal(mentionedSelf(no, '10000'), false)
})

test('fallbackUserMessage 形状与 dsh-llm 一致', () => {
  const message = fallbackUserMessage({ content: [{ type: 'text', text: 'x' }] })
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'user')
  assert.ok(message.id)
})

test('私聊白名单：收到消息 → 建会话 → 回复', async () => {
  const { channel, client } = makeChannel()
  channel.start()
  await channel.handleEvent({
    post_type: 'message',
    message_type: 'private',
    self_id: 10000,
    user_id: 10001,
    message_id: 1,
    raw_message: '帮我记住我喜欢夜里听雨',
    message: [{ type: 'text', data: { text: '帮我记住我喜欢夜里听雨' } }],
  })
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].action, 'send_private_msg')
  assert.equal(client.calls[0].params.user_id, 10001)
  assert.match(client.calls[0].params.message[0].data.text, /记住了/)
})

test('一句话都没答上来时说一声，不让人对着空气说话', async () => {
  const { channel, client } = makeChannel({ agents: fakeAgents({ reply: '' }) })
  channel.start()
  await channel.handleEvent({
    post_type: 'message',
    message_type: 'private',
    self_id: 10000,
    user_id: 10001,
    message_id: 9,
    message: [{ type: 'text', data: { text: '在吗' } }],
  })
  const sent = client.calls.filter((call) => call.action === 'send_private_msg')
  assert.equal(sent.length, 1)
  assert.match(sent[0].params.message[0].data.text, /卡了一下/)
})

test('关了 silentFallback 就安静着', async () => {
  const { channel, client } = makeChannel({ agents: fakeAgents({ reply: '' }), config: { silentFallback: false } })
  channel.start()
  await channel.handleEvent({
    post_type: 'message',
    message_type: 'private',
    self_id: 10000,
    user_id: 10001,
    message_id: 10,
    message: [{ type: 'text', data: { text: '在吗' } }],
  })
  assert.equal(client.calls.length, 0)
})

test('私聊不在白名单：不建会话、不回复', async () => {  const { channel, client } = makeChannel()
  await channel.handleEvent({
    post_type: 'message',
    message_type: 'private',
    self_id: 10000,
    user_id: 11111,
    message_id: 2,
    message: [{ type: 'text', data: { text: 'hello' } }],
  })
  assert.equal(client.calls.length, 0)
})

test('群聊：没 @ 不回，@ 了才回', async () => {
  const { channel, client } = makeChannel()
  const base = {
    post_type: 'message',
    message_type: 'group',
    self_id: 10000,
    group_id: 123456,
    user_id: 10001,
    message_id: 3,
  }
  await channel.handleEvent({ ...base, message: [{ type: 'text', data: { text: '在吗' } }] })
  assert.equal(client.calls.length, 0)

  await channel.handleEvent({
    ...base,
    message_id: 4,
    message: [
      { type: 'at', data: { qq: '10000' } },
      { type: 'text', data: { text: ' 在吗' } },
    ],
  })
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].action, 'send_group_msg')
  assert.equal(client.calls[0].params.group_id, 123456)
})

test('重复 message_id 只处理一次', async () => {
  const { channel, client } = makeChannel()
  const ev = {
    post_type: 'message',
    message_type: 'private',
    self_id: 10000,
    user_id: 10001,
    message_id: 99,
    message: [{ type: 'text', data: { text: '第一次' } }],
  }
  await channel.handleEvent(ev)
  await channel.handleEvent(ev)
  assert.equal(client.calls.length, 1)
})

test('/reset 会重开会话并回一句', async () => {
  const { channel, client } = makeChannel()
  const ev = {
    post_type: 'message',
    message_type: 'private',
    self_id: 10000,
    user_id: 10001,
    message_id: 100,
    message: [{ type: 'text', data: { text: '/reset' } }],
  }
  await channel.handleEvent(ev)
  assert.equal(client.calls.length, 1)
  assert.match(client.calls[0].params.message[0].data.text, /重新开始/)
})

test('autoReply=false 只听不回：记下来说话时间，但不建会话', async () => {
  const agents = fakeAgents()
  const { channel, client } = makeChannel({ config: { autoReply: false }, agents })
  const ev = {
    post_type: 'message',
    message_type: 'private',
    self_id: 10000,
    user_id: 10001,
    message_id: 101,
    message: [{ type: 'text', data: { text: '在吗' } }],
  }
  await channel.handleEvent(ev)
  assert.equal(agents.created.length, 0)
  assert.equal(client.calls.length, 0)
  assert.ok(channel.lastInboundAt > 0)
  assert.equal(channel.status().autoReply, false)
  assert.ok(channel.entries.some((line) => line.kind === 'observe'))
})

test('autoReply 默认开启', () => {
  assert.equal(QqChannel.defaults().autoReply, true)
})
test('只听不回时，群里别人闲聊不算「他说话了」', async () => {
  const { channel } = makeChannel({ config: { autoReply: false } })
  const groupEv = (text, id) => ({
    post_type: 'message',
    message_type: 'group',
    group_id: 123456,
    self_id: 10000,
    user_id: 20002,
    message_id: id,
    message: [{ type: 'text', data: { text } }],
  })
  await channel.handleEvent(groupEv('随便聊聊', 201))
  assert.equal(channel.lastInboundAt, 0)

  const atEv = groupEv('@我 在吗', 202)
  atEv.message = [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 在吗' } }]
  await channel.handleEvent(atEv)
  assert.ok(channel.lastInboundAt > 0)
})
test('splitBubbles：按句号拆成多条，最多 max 条，剩下的并进最后一条', () => {
  assert.deepEqual(splitBubbles('在。', 3), ['在。'])
  const one = splitBubbles('今天吃了饭。然后去散步了。晚上看了会儿书。', 2, 10)
  assert.equal(one.length, 2)
  assert.ok(one[1].includes('晚上看了会儿书'))
  const capped = splitBubbles('一。二。三。四。五。六。', 3, 3)
  assert.equal(capped.length, 3)
  assert.equal(capped.join(''), '一。二。三。四。五。六。')
  assert.deepEqual(splitBubbles('没有句号的句子', 3), ['没有句号的句子'])
  assert.deepEqual(splitBubbles('   ', 3), [])
})

test('ownerQQ 解析出的地址能真的走 say 发到私聊', async () => {
  const client = new FakeClient()
  client.connect()
  const channel = new QqChannel({
    client,
    agents: {},
    config: { ...QqChannel.defaults(), enabled: true, burst: false, voiceOut: 'off' },
    logger: { warn() {}, error() {}, log() {} },
  })
  const target = ownerTarget({ ownerQQ: '2285450525' })
  assert.equal(target, 'private:2285450525')
  const ok = await channel.say(target, '测试一句')
  assert.equal(ok, true)
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].action, 'send_private_msg')
  assert.equal(client.calls[0].params.user_id, 2285450525)
  assert.equal(client.calls[0].params.message[0].data.text, '测试一句')
})

test('没填主人 QQ、也没填 target 时 say 不会乱发', async () => {
  const client = new FakeClient()
  client.connect()
  const channel = new QqChannel({
    client,
    agents: {},
    config: { ...QqChannel.defaults(), enabled: true },
    logger: { warn() {}, error() {}, log() {} },
  })
  const target = ownerTarget({ ownerQQ: '', target: '' })
  assert.equal(target, '')
  assert.equal(await channel.say(target, '不该发出去'), false)
  assert.equal(client.calls.length, 0)
})
test('语音的节奏：off 不发，always 每次，auto 每 voiceEvery 次', () => {
  assert.equal(voiceCadence({ mode: 'off', turns: 3, every: 3 }), false)
  assert.equal(voiceCadence({ mode: 'false', turns: 3, every: 3 }), false)
  assert.equal(voiceCadence({ mode: 'always', turns: 1, every: 3 }), true)
  assert.equal(voiceCadence({ mode: 'auto', turns: 2, every: 3 }), false)
  assert.equal(voiceCadence({ mode: 'auto', turns: 3, every: 3 }), true)
  assert.equal(voiceCadence({ mode: 'auto', turns: 6 }), true) // 默认 every = 3
  assert.equal(voiceCadence({ mode: 'auto', turns: 0 }), false)
})

test('开语音也不耽误发文字：语音只是加在文字后面的一层', async () => {
  const msg = (id, text) => ({
    post_type: 'message',
    message_type: 'private',
    self_id: 10000,
    user_id: 10001,
    message_id: id,
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
  })
  const { channel, client } = makeChannel({ config: { voiceOut: 'always' } })
  channel.start()
  await channel.handleEvent(msg(31, '在吗'))
  const texts = client.calls.filter((c) => c.action === 'send_private_msg')
  assert.equal(texts.length, 1, '文字必须发出去')
  assert.equal(texts[0].params.message[0].type, 'text')
  assert.match(texts[0].params.message[0].data.text, /记住了/)
  channel.stop()
})

test('想说语音、可是 TTS 不在的时候：文字照发，只记一条 tts-skip', async () => {
  const msg = (id, text) => ({
    post_type: 'message',
    message_type: 'private',
    self_id: 10000,
    user_id: 10001,
    message_id: id,
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
  })
  const logs = []
  const clients = new FakeClient()
  const channel = new QqChannel({
    client: clients,
    agents: fakeAgents(),
    config: { ...QqChannel.defaults(), enabled: true, allowPrivate: ['10001'], voiceOut: 'always', ttsUrl: '' },
    logger: console,
    onLog: (entry) => logs.push(entry),
  })
  channelRef = channel
  channel.start()
  await channel.handleEvent(msg(32, '在吗'))
  assert.equal(clients.calls.filter((c) => c.action === 'send_private_msg').length, 1, '文字照发')
  assert.ok(logs.some((e) => e.kind === 'tts-skip'), '要记一条为什么没语音')
  channel.stop()
})

test('语音节奏跟着会话走：重启之后不会又从第一条开始数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-qqcadence-'))
  const historyFile = join(dir, 'qq-history.json')
  const message = (id, text) => ({
    post_type: 'message',
    message_type: 'private',
    self_id: 10000,
    user_id: 10001,
    message_id: id,
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
  })
  try {
    // 先聊两轮，攒下两条历史
    const first = makeChannel({ config: { historyFile, voiceEvery: 3 } })
    first.channel.start()
    await first.channel.handleEvent(message(41, '在吗'))
    await first.channel.handleEvent(message(42, '今天好累'))
    first.channel.stop()

    // 重新起一个通道（等于重启 / 改设置后重建），第三轮就该轮到语音
    const logs = []
    const second = makeChannel({
      config: { historyFile, voiceEvery: 3, ttsUrl: '' },
      onLog: (entry) => logs.push(entry),
    })
    second.channel.start()
    await second.channel.handleEvent(message(43, '在吗'))
    assert.equal(
      second.client.calls.filter((c) => c.action === 'send_private_msg').length,
      1,
      '文字照发'
    )
    assert.ok(
      logs.some((e) => e.kind === 'tts-skip'),
      '第三轮应该是语音那一轮（TTS 不在时记一条 tts-skip）'
    )
    second.channel.stop()

    // 对照：全新会话第一条，不该轮语音
    const freshLogs = []
    const fresh = makeChannel({ config: { voiceEvery: 3, ttsUrl: '' }, onLog: (entry) => freshLogs.push(entry) })
    fresh.channel.start()
    await fresh.channel.handleEvent(message(44, '在吗'))
    assert.ok(!freshLogs.some((e) => e.kind === 'tts-skip'), '第一条不该轮到语音')
    fresh.channel.stop()
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {}
  }
})

test('想听一条语音的时候，不用等「每隔三条」', async () => {
  assert.equal(wantsVoice('给我们发一条语音吧'), true)
  assert.equal(wantsVoice('说句话听听'), true)
  assert.equal(wantsVoice('唱一个呗'), true)
  assert.equal(wantsVoice('语音识别又坏了'), false)
  assert.equal(wantsVoice('这个插件带语音功能吗'), false)
  assert.equal(wantsVoice(''), false)

  const msg = (id, text) => ({
    post_type: 'message',
    message_type: 'private',
    self_id: 10000,
    user_id: 10001,
    message_id: id,
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
  })
  const logs = []
  const first = makeChannel({ config: { voiceEvery: 3, ttsUrl: '' }, onLog: (entry) => logs.push(entry) })
  first.channel.start()
  await first.channel.handleEvent(msg(51, '发一条语音吧'))
  assert.equal(first.client.calls.filter((c) => c.action === 'send_private_msg').length, 1, '文字照发')
  assert.ok(logs.some((e) => e.kind === 'tts-skip'), '第一轮就该轮到语音（不是等第三轮）')
  first.channel.stop()

  const plainLogs = []
  const plain = makeChannel({ config: { voiceEvery: 3, ttsUrl: '' }, onLog: (entry) => plainLogs.push(entry) })
  plain.channel.start()
  await plain.channel.handleEvent(msg(52, '在吗'))
  assert.ok(!plainLogs.some((e) => e.kind === 'tts-skip'), '没提语音时，第一轮还是不打语音')
  plain.channel.stop()
})

test('重启之后还记得刚才聊到哪：qq-history 接上话', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-qqrestart-'))
  const historyFile = join(dir, 'qq-history.json')
  const message = (id, text) => ({
    post_type: 'message',
    message_type: 'private',
    self_id: 10000,
    user_id: 10001,
    message_id: id,
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
  })
  try {
    const first = makeChannel({ config: { historyFile } })
    first.channel.start()
    await first.channel.handleEvent(message(21, '他叫我别熬夜，早点睡'))
    assert.equal(first.client.calls.length, 1)
    first.channel.stop()

    const agents2 = fakeAgents()
    const second = makeChannel({ config: { historyFile }, agents: agents2 })
    second.channel.start()
    await second.channel.handleEvent(message(22, '在吗'))
    assert.equal(agents2.created.length, 1, '重启后应该重新建会话')
    const body = agents2.created[0].message.content[0].text
    assert.match(body, /聊过的最后几句/)
    assert.match(body, /别熬夜/)
    assert.match(body, /下面是老大刚发来的/)
    assert.match(body, /在吗/)
    second.channel.stop()
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {}
  }
})