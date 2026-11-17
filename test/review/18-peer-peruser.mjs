/**
 * 原 test-peer-peruser.mjs：peer 键。
 * 接口差异（要紧）：他群里按人切（`group:gid@uid`），我群档是整群一个（`group:<gid>`）——
 * 群里好几个人共用一个档，谁说的靠正文里的发言人那句区分（见 04）。
 * 这条验我这边真实的键：私聊 `private:<号>`，群聊 `group:<群号>`。
 */
import { assert, drop, groupEvent, makeChannel, mkStore, pass, privateEvent } from './_lib.mjs'

const ctx = mkStore('seed-review-peer-')
try {
  // ① 私聊
  const one = makeChannel({ config: { ownerQQ: '10001' } })
  one.channel.start()
  await one.channel.handleEvent(privateEvent({ userId: 10001, text: '在吗' }))
  const recPrivate = [...one.channel.records.values()][0]
  const peerPrivate = one.channel.peerOf(recPrivate.sessionId)
  assert.equal(peerPrivate.key, 'private:10001', `私聊键：${JSON.stringify(peerPrivate)}`)
  await one.channel.stop()

  // ② 群聊：张三、李四说的都是同一个群档
  const two = makeChannel({ config: { ownerQQ: '10001', groupRequireAt: false } })
  two.channel.start()
  await two.channel.handleEvent(groupEvent({ userId: 20001, card: '张三', text: '第一句', messageId: 1 }))
  await two.channel.handleEvent(groupEvent({ userId: 20002, card: '李四', text: '第二句', messageId: 2 }))
  const recGroup = [...two.channel.records.values()][0]
  const peerGroup = two.channel.peerOf(recGroup.sessionId)
  assert.equal(peerGroup.key, 'group:123456', `群聊键：${JSON.stringify(peerGroup)}`)
  assert.equal(String(peerGroup.peer), '123456')
  // 两个人都落在同一个群档里（这是设计，不是漏）
  assert.equal(recGroup.lastSpeaker.id, '20002', '但要知道最后一句是谁说的')
  assert.equal(recGroup.lastSpeaker.name, '李四')
  await two.channel.stop()

  pass('peer-peruser：私聊按号、群聊按群；群里谁说的靠 lastSpeaker 记着')
} finally {
  drop(ctx)
}
