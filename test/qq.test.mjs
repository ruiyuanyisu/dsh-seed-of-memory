import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { QqChannel, splitBubbles, splitOutsideQuotes, trimTailBubbles, voiceFallback, voiceCadence, samePath } from '../lib/qq/channel.js'
import { QqHistory } from '../lib/qq/history.js'
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

function makeChannel({ config = {}, agents, client = new FakeClient(), onLog, attachWorkspace = null, history = null } = {}) {
  const merged = {
    ...QqChannel.defaults(),
    enabled: true,
    allowPrivate: ['10001'],
    allowGroups: ['123456'],
    // 测试里不等静默；专门测防抖的用例自己传 debounceMs
    debounceMs: 0,
    ...config,
  }
  const channel = new QqChannel({ client, agents: agents ?? fakeAgents(), config: merged, logger: console, onLog, attachWorkspace, history })
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

test('宿主内部出错时，别把 RemoteError 那串原文发进聊天', async () => {
  const { channel, client } = makeChannel({
    agents: fakeAgents({ reply: '```\n: RemoteError: gateway/internal: resume failed for session "x": core-memory (dsh-core-memory): never started\n```' }),
  })
  channel.start()
  await channel.handleEvent({
    post_type: 'message',
    message_type: 'private',
    self_id: 10000,
    user_id: 10001,
    message_id: 11,
    message: [{ type: 'text', data: { text: '在吗' } }],
  })
  const sent = client.calls.filter((call) => call.action === 'send_private_msg')
  assert.equal(sent.length, 1)
  const text = sent[0].params.message[0].data.text
  assert.doesNotMatch(text, /RemoteError|never started|resume failed/)
  assert.match(text, /卡了一下/)
  assert.ok(channel.status().log.some((line) => line.kind === 'debug' && /内部错误/.test(line.text)))
})

test('宿主的报错被当成一条消息递进来时，不回它、也不记成他说的话', async () => {
  const { channel, client } = makeChannel({ agents: fakeAgents({ reply: '收到' }) })
  channel.start()
  await channel.handleEvent({
    post_type: 'message',
    message_type: 'private',
    self_id: 10000,
    user_id: 10001,
    message_id: 12,
    message: [
      {
        type: 'text',
        data: { text: '⚠️ 消息未被接受：gateway/internal: resume failed for session "x": RemoteError: core-memory (dsh-core-memory): never started' },
      },
    ],
  })
  const sent = client.calls.filter((call) => call.action === 'send_private_msg')
  assert.equal(sent.length, 0, '不该拿这串报错去回话')
  assert.ok(channel.status().log.some((line) => line.kind === 'skip' && /内部报错/.test(line.text)))
  const history = channel.history?.get?.('private:10001') ?? []
  assert.equal(history.length, 0, '报错不是他说的，别记进历史')
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

test('一整段没有标点也别拆成一串小消息，更不能整条超长', () => {
  for (const text of ['a'.repeat(5000), '没有标点'.repeat(1000), '你好。'.repeat(200)]) {
    const bubbles = splitBubbles(text)
    assert.ok(bubbles.length <= 6, `气泡太多：${bubbles.length}`)
    assert.ok(Math.max(...bubbles.map((b) => b.length)) <= 1200, '单条太长，QQ 会拒收')
    assert.equal(bubbles.join('').replace(/\s+/g, ''), text.replace(/\s+/g, ''), '切的时候不能丢字')
  }
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
  const target = ownerTarget({ ownerQQ: '100000001' })
  assert.equal(target, 'private:100000001')
  const ok = await channel.say(target, '测试一句')
  assert.equal(ok, true)
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].action, 'send_private_msg')
  assert.equal(client.calls[0].params.user_id, 100000001)
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
    config: { ...QqChannel.defaults(), enabled: true, allowPrivate: ['10001'], voiceOut: 'always', ttsUrl: '', debounceMs: 0 },
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
  // 说了「别发语音」就是不要，别顺着字面发；「我发了一条语音给你」是在说他自己。
  assert.equal(wantsVoice('别发语音了'), false)
  assert.equal(wantsVoice('不用发语音'), false)
  assert.equal(wantsVoice('不要发语音'), false)
  assert.equal(wantsVoice('我发了一条语音给你'), false)
  assert.equal(wantsVoice('我刚刚给你发了条语音'), false)
  assert.equal(wantsVoice('可以发个语音吗'), true)

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
test('旧会话记录坏掉时，换一个新 id 也要把会话建起来', async () => {
  const seen = []
  const agents = {
    get() {
      return null
    },
    async resume() {
      throw new Error('RemoteError: core-memory: never started')
    },
    async create({ sessionId }) {
      seen.push(sessionId)
      // 第一次用原来的 id 建：宿主会先去恢复那份坏记录，照样炸
      if (seen.length === 1) throw new Error('resume failed for session "x": never started')
      return { agent: { followup() {}, async whenIdle() {} }, dispose() {} }
    },
  }
  const { channel, client } = makeChannel({ agents, config: { replyTimeoutMs: 40, silentFallback: false } })
  channel.start()
  await channel.handleEvent({
    post_type: 'message',
    message_type: 'private',
    self_id: 10000,
    user_id: 10001,
    message_id: 31,
    message: [{ type: 'text', data: { text: '在吗' } }],
  })
  assert.equal(seen.length, 2, '第一个 id 建不起来时，应该换一个新 id 再试一次')
  assert.match(seen[1], /^seedqq-[a-z0-9]+-r[a-z0-9]+$/)
  // 会话确实建起来了（没丢消息，只是这一轮没内容可回）
  assert.equal(channel.records.size, 1)
  channel.stop()
})

test('会话建好就顺手挂进工作区，cwd 对不上就不挂', async () => {
  const attached = []
  const attachWorkspace = async (sessionId, cwd) => {
    attached.push({ sessionId, cwd })
    return true
  }
  const withCwd = makeChannel({ config: { cwd: 'E:\\cz', replyTimeoutMs: 40 }, attachWorkspace })
  withCwd.channel.start()
  await withCwd.channel.handleEvent({
    post_type: 'message',
    message_type: 'private',
    self_id: 10000,
    user_id: 10001,
    message_id: 41,
    message: [{ type: 'text', data: { text: '在吗' } }],
  })
  withCwd.channel.stop()
  assert.equal(attached.length, 1)
  assert.match(attached[0].sessionId, /^seedqq-/)
  assert.equal(attached[0].cwd, 'E:\\cz')

  const noCwd = makeChannel({ config: { cwd: '', replyTimeoutMs: 40 }, attachWorkspace })
  noCwd.channel.start()
  await noCwd.channel.handleEvent({
    post_type: 'message',
    message_type: 'private',
    self_id: 10000,
    user_id: 10001,
    message_id: 42,
    message: [{ type: 'text', data: { text: '在吗' } }],
  })
  noCwd.channel.stop()
  assert.equal(attached.length, 1, '没有 cwd 就不用去挂')
})

test('samePath：大小写、斜杠、尾部分隔符都不计较', () => {
  assert.equal(samePath('D:\\work', 'd:/work/'), true)
  assert.equal(samePath('D:\\work', 'E:\\cz'), false)
  assert.equal(samePath('', 'D:\\work'), false)
  assert.equal(samePath(undefined, undefined), false)
})

function privateEvent(id, text) {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: 10000,
    user_id: 10001,
    message_id: id,
    message: [{ type: 'text', data: { text } }],
  }
}

test('配置里的 cwd 变了，旧会话会换成新会话，并记住换过的 id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedqq-map-'))
  const file = join(dir, 'qq-history.json')
  const created = []
  const attached = []
  const stock = () => ({ header: { cwd: 'E:\\cz' }, followup() {}, async whenIdle() {} })
  const agents = {
    get() {
      return null
    },
    async resume() {
      return { agent: stock(), dispose() {} }
    },
    async create({ sessionId, meta }) {
      created.push({ sessionId, cwd: meta?.cwd })
      return {
        agent: {
          header: { cwd: meta?.cwd },
          followup() {
            setTimeout(() => {
              channelRef?.onSessionEvent(
                { header: { id: sessionId } },
                { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '嗯。' }] } } },
              )
            }, 5)
          },
          async whenIdle() {},
        },
        dispose() {},
      }
    },
  }
  const history = new QqHistory(file)
  const { channel } = makeChannel({
    agents,
    history,
    config: { cwd: 'D:\\work', replyTimeoutMs: 30, silentFallback: false },
    attachWorkspace: async (sessionId, cwd) => {
      attached.push({ sessionId, cwd })
    },
  })
  channel.start()
  await channel.handleEvent(privateEvent(61, '在吗'))
  channel.stop()

  assert.equal(created.length, 1, '旧会话的 cwd 不对，应该重开一份')
  assert.match(created[0].sessionId, /-r[a-z0-9]+$/)
  assert.equal(created[0].cwd, 'D:\\work')
  assert.equal(attached.at(-1)?.cwd, 'D:\\work')
  const mapped = history.sessionOf('private:10001')
  assert.equal(mapped, created[0].sessionId)
  history.dispose()

  // 落盘了：另开一个账本读回来还是这个 id
  const reread = new QqHistory(file).load()
  assert.equal(reread.sessionOf('private:10001'), created[0].sessionId)
  reread.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('换过 id 之后重启，还接着用记下来的那个会话', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedqq-remap-'))
  const file = join(dir, 'qq-history.json')
  const first = []
  const agents1 = {
    get() {
      return null
    },
    async resume() {
      throw new Error('no session')
    },
    async create({ sessionId, meta }) {
      first.push(sessionId)
      return {
        agent: {
          header: { cwd: meta?.cwd },
          followup() {
            setTimeout(() => {
              channelRef?.onSessionEvent(
                { header: { id: sessionId } },
                { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '嗯。' }] } } },
              )
            }, 5)
          },
          async whenIdle() {},
        },
        dispose() {},
      }
    },
  }
  const history1 = new QqHistory(file)
  const one = makeChannel({ agents: agents1, history: history1, config: { cwd: 'D:\\work', replyTimeoutMs: 30, silentFallback: false } })
  one.channel.start()
  await one.channel.handleEvent(privateEvent(71, '在吗'))
  one.channel.stop()
  const kept = first[0]
  assert.match(kept, /^seedqq-[a-z0-9]+$/)
  history1.dispose()

  // 重启：账本里有 id，就该先 resume 这个 id（而不是回到老的 hash id 再换一次）
  const resumed = []
  const second = []
  const agents2 = {
    get() {
      return null
    },
    async resume({ resumeSessionId }) {
      resumed.push(resumeSessionId)
      throw new Error('no session')
    },
    async create({ sessionId }) {
      second.push(sessionId)
      return {
        agent: {
          header: { cwd: 'D:\\work' },
          followup() {
            setTimeout(() => {
              channelRef?.onSessionEvent(
                { header: { id: sessionId } },
                { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '嗯。' }] } } },
              )
            }, 5)
          },
          async whenIdle() {},
        },
        dispose() {},
      }
    },
  }
  const history2 = new QqHistory(file)
  const two = makeChannel({ agents: agents2, history: history2, config: { cwd: 'D:\\work', replyTimeoutMs: 30, silentFallback: false } })
  two.channel.start()
  await two.channel.handleEvent(privateEvent(72, '又来了'))
  two.channel.stop()

  assert.equal(resumed[0], kept, '重启后应该先恢复上次记下的会话')
  assert.equal(second[0], kept, '没换 cwd 就不该再换 id')
  history2.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('/reset 之后下一句是真正的新会话，不是把旧的恢复回来', async () => {
  const created = []
  const agents = {
    get() {
      return null
    },
    async resume() {
      throw new Error('no session')
    },
    async create({ sessionId }) {
      created.push(sessionId)
      let reply = '嗯。'
      return {
        agent: {
          header: { cwd: 'D:\\work' },
          followup() {
            setTimeout(() => {
              channelRef?.onSessionEvent(
                { header: { id: sessionId } },
                { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } },
              )
            }, 5)
          },
          async whenIdle() {},
        },
        dispose() {},
      }
    },
  }
  const { channel } = makeChannel({ agents, config: { cwd: 'D:\\work', replyTimeoutMs: 40 } })
  channel.start()
  await channel.handleEvent(privateEvent(81, '在吗'))
  assert.equal(created.length, 1)
  const before = created[0]

  await channel.handleEvent(privateEvent(82, '/reset'))
  await channel.handleEvent(privateEvent(83, '重新开始吧'))
  channel.stop()

  assert.equal(created.length, 2, '/reset 之后应该重开一份会话')
  assert.notEqual(created[1], before)
  assert.match(created[1], /-r[a-z0-9]+$/)
})

test('连着两条消息同时到，也只建一份会话', async () => {
  let creates = 0
  const agents = {
    get() {
      return null
    },
    async resume() {
      throw new Error('no session')
    },
    async create({ sessionId }) {
      creates += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return {
        agent: {
          header: { cwd: 'D:\\work' },
          followup() {
            setTimeout(() => {
              channelRef?.onSessionEvent(
                { header: { id: sessionId } },
                { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '嗯。' }] } } },
              )
            }, 5)
          },
          async whenIdle() {},
        },
        dispose() {},
      }
    },
  }
  const { channel } = makeChannel({ agents, config: { cwd: 'D:\\work', replyTimeoutMs: 20, silentFallback: false } })
  channel.start()
  // 不 await，模拟「两条消息同一拍进来」（start 里也是 .catch 而不 await）
  const first = channel.handleEvent(privateEvent(91, '在吗'))
  const second = channel.handleEvent(privateEvent(92, '喂'))
  await Promise.all([first, second])
  const recordCount = channel.records.size
  channel.stop()
  assert.equal(creates, 1, '两条消息不该各建一份会话')
  assert.equal(recordCount, 1)
})



test('人说的话里带 RemoteError 这种词，别当成宿主报错吞掉', async () => {
  const { channel, client } = makeChannel({ agents: fakeAgents({ reply: '在的。' }) })
  await channel.start()
  const human = ['RemoteError 是什么梗', 'session persistence 这词怎么翻', '我上次 resume failed 了', 'never started 这个词组好怪']
  for (const [index, text] of human.entries()) {
    await channel.handleEvent(privateEvent(200 + index, text))
  }
  const sent = client.calls.filter((call) => call.action === 'send_private_msg')
  assert.equal(sent.length, human.length, '每一句人话都该回')
  assert.ok(!channel.entries.some((entry) => entry.kind === 'skip' && /内部报错/.test(entry.text)), '不该有人话被当成内部报错跳过')
})

test('真正的宿主报错仍然拦下来：不当消息回、也不发出去', async () => {
  const { channel, client } = makeChannel({ agents: fakeAgents({ reply: 'RemoteError: resume failed for session "x": never started' }) })
  await channel.start()
  await channel.handleEvent(privateEvent(300, 'RemoteError: resume failed for session "x": never started'))
  await channel.handleEvent(privateEvent(301, '在吗'))
  const sent = client.calls.filter((call) => call.action === 'send_private_msg')
  assert.equal(sent.length, 1, '报错那条不该回，正常那条要回')
  assert.ok(!JSON.stringify(sent).includes('RemoteError'), '回复里不能带报错原文')
  assert.ok(channel.entries.some((entry) => entry.kind === 'skip' && /内部报错/.test(entry.text)))
})

test('坏会话名单会写进账本，重启后不用再撞一次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedqq-broken-'))
  const file = join(dir, 'qq-history.json')
  const failing = {
    get() { return null },
    async resume() { throw new Error('no session') },
    async create({ sessionId }) {
      if (!sessionId.includes('-r')) throw new Error('resume failed for session "old": never started')
      return { agent: { header: { cwd: 'D:\\work' }, followup() { setTimeout(() => { channelRef?.onSessionEvent({ header: { id: sessionId } }, { type: 'turn/end', data: {} }) }, 5) }, async whenIdle() {} }, dispose() {} }
    },
  }
  const first = makeChannel({ agents: failing, history: new QqHistory(file) })
  first.channel.history.load()
  await first.channel.start()
  await first.channel.handleEvent(privateEvent(400, '在吗'))
  first.channel.history.flush()
  const again = new QqHistory(file).load()
  assert.equal(again.brokenIds().length, 1, '坏 id 要落盘')
  const second = makeChannel({ agents: failing, history: again })
  assert.equal(second.channel.brokenSessions.size, 1, '重启之后名单要在')
  second.channel.stop()
})

test('挂工作区会等 header 落盘：前两次失败、第三次成功', async () => {
  const logs = []
  let attempts = 0
  const attach = async () => {
    attempts += 1
    if (attempts < 3) throw new Error('carries no cwd to validate against')
    return true
  }
  const { channel } = makeChannel({ config: { cwd: 'D:\\work' }, agents: fakeAgents({ reply: '嗯。' }), attachWorkspace: attach, onLog: (entry) => logs.push(entry.kind + ' ' + entry.text) })
  await channel.start()
  await channel.handleEvent(privateEvent(500, '在吗'))
  await new Promise((resolve) => setTimeout(resolve, 1400))
  assert.ok(attempts >= 3, '应该重试到成功，实际 ' + attempts)
  assert.ok(logs.some((line) => line.includes('挂进工作区：')), '挂上了要留一行 debug：' + logs.join(' | '))
  channel.stop()
})



test('配了 routes 就按路由接：不在 accept 里的人不回', async () => {
  const { channel, client } = makeChannel({
    config: { routes: [{ id: 'main', cwd: 'D:\\work', accept: { private: ['111'], groups: [] } }] },
    agents: fakeAgents({ reply: '嗯。' }),
  })
  await channel.start()
  await channel.handleEvent({ ...privateEvent('r700', '在吗'), user_id: 999, sender: { user_id: 999 } })
  assert.equal(client.calls.filter((call) => call.action === 'send_private_msg').length, 0, '不在 accept 里的人不该回')
  assert.ok(channel.entries.some((entry) => entry.kind === 'deny' && /没有一条路由认它/.test(entry.text)))
  await channel.handleEvent({ ...privateEvent('r701', '在吗'), user_id: 111, sender: { user_id: 111 } })
  assert.equal(client.calls.filter((call) => call.action === 'send_private_msg').length, 1, 'accept 里的人要回')
})

test('路由的 cwd 和记忆档位跟着会话走', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedqq-routecwd-'))
  const created = []
  const agents = {
    get() { return null },
    async resume() { throw new Error('no session') },
    async create({ sessionId, meta }) {
      created.push({ sessionId, cwd: meta?.cwd })
      return {
        agent: {
          header: { cwd: meta?.cwd },
          followup() { setTimeout(() => channelRef?.onSessionEvent({ header: { id: sessionId } }, { type: 'turn/end', data: {} }), 5) },
          async whenIdle() {},
        },
        dispose() {},
      }
    },
  }
  const { channel } = makeChannel({
    config: { routes: [{ id: 'tsuki', cwd: dir, accept: { private: ['*'], groups: [] }, memoryScope: 'gui' }] },
    agents,
  })
  await channel.start()
  await channel.handleEvent(privateEvent(800, '在吗'))
  assert.equal(created.length, 1)
  assert.equal(created[0].cwd, dir, '会话要落在路由给的 cwd 里')
  assert.equal(channel.scopeOf(created[0].sessionId), 'gui', '记忆档位跟着路由')
  channel.stop()
})

test('引号里的句号不算断句：话说了一半别切断', () => {
  const parts = splitOutsideQuotes('我说「好。然后呢」就算了。明天再说。')
  assert.deepEqual(parts.map((p) => p.trim()), ['我说「好。然后呢」就算了。', '明天再说。'])
  // 括号同理
  const bracket = splitOutsideQuotes('（这里有个句号。但没说完）继续。')
  assert.equal(bracket.length, 1, '括号里的句号不该断开')
  assert.ok(bracket[0].includes('句号。但没说完'))
  const bubbles = splitBubbles('我说「先别动。等我回来」这件事。然后走了。', 3, 90)
  assert.ok(bubbles[0].includes('先别动。等我回来'), '引号里那句不该被切到第二条去')
})

test('收尾只发寒暄时，少发一条', () => {
  assert.deepEqual(trimTailBubbles(['今天去山里了。', '晚安。']), ['今天去山里了。'])
  assert.deepEqual(trimTailBubbles(['晚安。']), ['晚安。'], '只有一条时不能丢光')
  assert.deepEqual(trimTailBubbles(['今天去山里了。', '记得带伞。']), ['今天去山里了。', '记得带伞。'])
})

test('连着发两条，等静默合成一轮再回', async () => {
  const agents = fakeAgents()
  const { channel } = makeChannel({ agents, config: { debounceMs: 15, debounceMaxMs: 200 } })
  await channel.start()
  await channel.handleEvent(privateEvent(1, '在吗'))
  await channel.handleEvent(privateEvent(2, '我有点事想问你'))
  assert.equal(agents.created.length, 0, '静默还没到，不该先回')
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(agents.created.length, 1, '两条只该合成一轮')
  const body = agents.created[0].message.content[0].text
  assert.ok(body.includes('在吗') && body.includes('我有点事想问你'), '两条内容都要在')
  channel.stop()
})

test('最后一条只是寒暄，就不单独发出去', async () => {
  const agents = fakeAgents({ reply: '今天很累。晚安。' })
  const { channel, client } = makeChannel({ agents, config: { debounceMs: 0 } })
  await channel.start()
  await channel.handleEvent(privateEvent(1, '在吗'))
  const texts = client.calls.map((c) => c.params?.message?.[0]?.data?.text).filter(Boolean)
  assert.deepEqual(texts, ['今天很累。'], '晚安那条不该发')
  channel.stop()
})

test('发送超时只记「结果未知」，不重发', async () => {
  const agents = fakeAgents()
  const logs = []
  const client = new FakeClient()
  client.call = async (action, params) => {
    client.calls.push({ action, params })
    throw new Error('TimeoutError: 20000ms exceeded')
  }
  const { channel } = makeChannel({ agents, client, onLog: (line) => logs.push(line), config: { debounceMs: 0 } })
  await channel.start()
  await channel.handleEvent(privateEvent(1, '在吗'))
  const sends = client.calls.filter((c) => c.action === 'send_private_msg')
  assert.equal(sends.length, 1, '超时了不该自己重发')
  assert.ok(logs.some((line) => line.kind === 'send-unknown'), '该记成结果未知')
  channel.stop()
})

test('每轮递给模型的话里都带着「你在 QQ 上」和语音那一行', async () => {
  // 记忆卡只在会话开头注入一次，后面几轮模型会以为自己在 GUI 里。
  // 所以这段提示得跟着每条消息走，不然它就不写 [语音] 那行。
  const agents = fakeAgents({ reply: '在的。' })
  const { channel } = makeChannel({ agents, config: { debounceMs: 0 } })
  await channel.start()
  await channel.handleEvent(privateEvent(1, '在吗'))
  const body = agents.created[0].message.content[0].text
  assert.match(body, /\[这一轮\]/, '要提醒它这是 QQ')
  assert.match(body, /\[语音\]/, '要提醒它写语音那行')
  channel.stop()
})

test('主动消息带语音时，文字照样先发（语音是加一层，不是替代品）', () => {
  const source = readFileSync(new URL('../lib/qq/channel.js', import.meta.url), 'utf8')
  assert.doesNotMatch(
    source,
    /if \(spoken\) return true/,
    '语音一发成功就 return，主动消息就只剩声音、没有字了',
  )
  assert.match(source, /let spoke = false/, '要先发文字，语音只当补一层')
  assert.match(source, /spoke = await this\.#sendVoice/)
})
