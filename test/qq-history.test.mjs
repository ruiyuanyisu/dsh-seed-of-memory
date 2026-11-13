import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { QqHistory } from '../lib/qq/history.js'
import { QqChannel } from '../lib/qq/channel.js'

function tmpFile(name = 'qq-history.json') {
  const dir = mkdtempSync(join(tmpdir(), 'seedqq-'))
  return join(dir, name)
}

test('QqHistory：记一轮、只留最近 maxTurns 轮', () => {
  const history = new QqHistory(tmpFile(), { maxTurns: 3 })
  for (let i = 1; i <= 5; i++) history.append('private:10001', { u: `他第${i}句`, a: `我第${i}句` })
  const turns = history.get('private:10001')
  assert.equal(turns.length, 3)
  assert.equal(turns[0].u, '他第3句')
  assert.equal(turns[2].a, '我第5句')
  history.dispose()
})

test('QqHistory：不同会话分开记，recap 拼成给模型看的一小段', () => {
  const history = new QqHistory(tmpFile())
  history.append('private:10001', { u: '在吗', a: '在呀' })
  history.append('group:20002', { u: '群里的', a: '群里的回' })
  const recap = history.recap('private:10001')
  assert.match(recap, /老大：在吗/)
  assert.match(recap, /你：在呀/)
  assert.match(recap, /不是新消息/)
  assert.doesNotMatch(recap, /群里的/)
  assert.equal(history.recap('private:99999'), '')
  history.dispose()
})

test('QqHistory：清掉一个会话不影响别的', () => {
  const history = new QqHistory(tmpFile())
  history.append('private:10001', { u: 'a', a: 'b' })
  history.append('private:10002', { u: 'c', a: 'd' })
  history.clear('private:10001')
  assert.deepEqual(history.get('private:10001'), [])
  assert.equal(history.get('private:10002').length, 1)
  history.dispose()
})

test('QqHistory：写盘之后重新读得回来', () => {
  const file = tmpFile()
  const first = new QqHistory(file)
  first.append('private:10001', { u: '昨天说的', a: '嗯嗯' })
  first.flush()
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(raw['private:10001'].length, 1)
  const second = new QqHistory(file)
  assert.equal(second.get('private:10001')[0].u, '昨天说的')
  first.dispose()
  second.dispose()
})

test('QqHistory：文件坏了也不炸，当成空账本', () => {
  const file = tmpFile()
  writeFileSync(file, '{ 这不是 json', 'utf8')
  const history = new QqHistory(file)
  assert.deepEqual(history.get('private:10001'), [])
  history.append('private:10001', { u: '还能记', a: '能' })
  assert.equal(history.get('private:10001').length, 1)
  history.dispose()
})

test('QqChannel：回完一句就进本地账本，重启后的第一个会话能拿到一次 recap', async () => {
  const file = tmpFile()
  const history = new QqHistory(file)
  history.append('private:10001', { u: '重启前的最后一句', a: '记得' })

  const client = {
    connected: true,
    status: () => ({ connected: true, selfId: '10000' }),
    connect() {},
    close() {},
    on() {},
    async call(action) {
      if (action === 'get_login_info') return { user_id: 10000 }
      return { status: 'ok', data: { message_id: 1 } }
    },
  }

  let channel = null
  const sent = []
  const agents = {
    get: () => null,
    async resume() {
      throw new Error('session "seedqq-x" not found')
    },
    async create({ sessionId }) {
      const agent = {
        followup(message) {
          sent.push({ text: message?.content?.[0]?.text ?? '' })
          setTimeout(() => {
            channel.onSessionEvent(
              { header: { id: sessionId } },
              { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我在呢' }] } } },
            )
          }, 5)
        },
        async whenIdle() {},
      }
      return { agent, dispose: async () => {} }
    },
  }

  channel = new QqChannel({
    client,
    agents,
    config: {
      allowPrivate: ['10001'],
      autoReply: true,
      burst: false,
      voiceOut: 'off',
      historyFile: file,
    },
    logger: { info() {}, warn() {}, error() {} },
    onLog() {},
    history,
  })
  channel.start()

  await channel.handleEvent({
    post_type: 'message',
    message_type: 'private',
    user_id: 10001,
    self_id: 10000,
    message_id: 42,
    raw_message: '在吗',
    message: [{ type: 'text', data: { text: '在吗' } }],
  })

  const turns = channel.history.get('private:10001')
  assert.equal(turns.at(-1).u, '在吗')
  assert.equal(turns.at(-1).a, '我在呢')

  // 账本里的「刚才」只补进新会话的第一条消息，并且只补一次
  assert.match(sent[0].text, /重启前的最后一句/)
  assert.match(sent[0].text, /在吗$/)
  const sessionId = channel.records.get('private:10001').sessionId
  assert.equal(channel.freshRecap(sessionId), '')

  channel.stop()
})
