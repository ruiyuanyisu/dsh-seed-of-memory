import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { QqChannel, splitBubbles } from '../lib/qq/channel.js'
import { ownerTarget } from '../lib/qq/proactive.js'
import { segmentsOf, textOf, mentionedSelf, fallbackUserMessage } from '../lib/qq/message.js'

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

function makeChannel({ config = {}, agents, client = new FakeClient() } = {}) {
  const merged = {
    ...QqChannel.defaults(),
    enabled: true,
    allowPrivate: ['10001'],
    allowGroups: ['123456'],
    ...config,
  }
  const channel = new QqChannel({ client, agents: agents ?? fakeAgents(), config: merged, logger: console })
  channelRef = channel
  return { channel, client }
}

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

test('私聊不在白名单：不建会话、不回复', async () => {
  const { channel, client } = makeChannel()
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
