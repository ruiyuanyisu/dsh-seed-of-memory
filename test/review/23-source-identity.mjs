/**
 * 原 test-source-identity.mjs：交给宿主的消息 source 里要带上身份。
 * 1.5.0 补的：channel 组装消息时不再只给 kind:'user'，还带 platform/scope/peerId/
 * userId/senderName/groupId/fromMe——面板和别的插件才看得出这是群里谁说的。
 * 另外验兜底实现不会把 source 洗掉（宿主没装 dsh-llm 时走的那条路）。
 */
import { assert, drop, fallbackUserMessage, groupEvent, makeChannel, mkStore, pass, privateEvent } from './_lib.mjs'

const ctx = mkStore('seed-review-source-')
try {
  // ① 兜底实现原样保留 source
  const source = {
    kind: 'user',
    platform: 'qq',
    scope: 'private',
    peerId: '10001',
    userId: '10001',
    senderName: '',
    groupId: '',
    fromMe: true,
  }
  const kept = fallbackUserMessage({ content: [{ type: 'text', text: 'x' }], source })
  assert.deepEqual(kept.source, source, '兜底实现不该改 source 的内容')

  // ② 群里张三说的：带上群号和昵称
  {
    const { channel, agents } = makeChannel({ config: { ownerQQ: '10001', groupRequireAt: false } })
    channel.start()
    await channel.handleEvent(groupEvent({ userId: 20001, card: '张三', text: '下雨了' }))
    const got = agents.created[0].message.source
    await channel.stop()
    assert.equal(got.platform, 'qq')
    assert.equal(got.scope, 'group')
    assert.equal(got.peerId, '123456')
    assert.equal(got.groupId, '123456')
    assert.equal(got.userId, '20001')
    assert.equal(got.senderName, '张三')
    assert.equal(got.fromMe, false, '不是我自己发的')
    assert.equal(got.kind, 'user', 'kind 还得是 user，宿主靠它认来源')
  }

  // ③ 群里我自己（10000）回显：fromMe 该是 true
  {
    const { channel, agents } = makeChannel({ config: { ownerQQ: '10001', groupRequireAt: false, allowGroups: ['123456'] } })
    channel.start()
    await channel.handleEvent(groupEvent({ userId: 10000, card: '', text: '我说的话', messageId: 3 }))
    const got = agents.created[0]?.message.source
    await channel.stop()
    if (got) assert.equal(got.fromMe, true, `自己发的要能看出来：${JSON.stringify(got)}`)
  }

  // ④ 老大私聊：userId 是他本人
  {
    const { channel, agents } = makeChannel({ config: { ownerQQ: '10001' } })
    channel.start()
    await channel.handleEvent(privateEvent({ userId: 10001, text: '在吗' }))
    const got = agents.created[0].message.source
    await channel.stop()
    assert.equal(got.scope, 'private')
    assert.equal(got.userId, '10001')
    assert.equal(got.groupId, '')
    assert.equal(got.fromMe, false, '老大发的也不是「我」发的')
  }

  pass('source-identity：消息 source 带身份，兜底实现原样保留')
} finally {
  drop(ctx)
}
