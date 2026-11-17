/**
 * 原 test-per-user.mjs：personKey —— 这条会话的记忆落在谁的档里。
 * 接口差异：他没有独立的 personKey，我这边是 scope 词表（`qq:<号>` / `group:<群号>`），
 * 由 lib/scope.js 统一生成，channel 的 scopeOf 只是把路由表里的配置翻出来。
 */
import { assert, drop, groupEvent, makeChannel, mkStore, pass, privateEvent } from './_lib.mjs'
import { canonScope, peerOfScope, scopeOfPeer, visibleScopes } from '../../lib/scope.js'

const ctx = mkStore('seed-review-peruser-')
try {
  // ① scope.js：两套键互推
  assert.equal(scopeOfPeer('private:10001'), 'qq:10001')
  assert.equal(scopeOfPeer('group:123456'), 'group:123456')
  assert.equal(peerOfScope('qq:10001'), 'private:10001')
  assert.equal(peerOfScope('group:123456'), 'group:123456')
  assert.equal(peerOfScope('shared'), null)
  // 老桶 qq 不再跟着每个人走：升级前那一桶里混着别人的话（REVIEW-150 第三轮）。
  assert.deepEqual(visibleScopes('qq:10001'), ['shared', 'qq:10001'])
  assert.deepEqual(visibleScopes('gui'), ['shared', 'gui', 'qq'])

  // ② 私聊：档落在本人名下
  const one = makeChannel({ config: { ownerQQ: '10001' } })
  one.channel.start()
  await one.channel.handleEvent(privateEvent({ userId: 10001, text: '在吗' }))
  const rec = [...one.channel.records.values()][0]
  assert.equal(one.channel.scopeOf(rec.sessionId), 'qq:10001')
  await one.channel.stop()

  // ③ 群聊：档落在群名下
  const two = makeChannel({ config: { ownerQQ: '10001', groupRequireAt: false } })
  two.channel.start()
  await two.channel.handleEvent(groupEvent({ userId: 20001, card: '张三', text: '下雨了' }))
  const recGroup = [...two.channel.records.values()][0]
  assert.equal(two.channel.scopeOf(recGroup.sessionId), 'group:123456')
  await two.channel.stop()

  // ④ 路由表配了 shared/gui 就听配置（不是所有 QQ 都分人）
  const three = makeChannel({ config: { ownerQQ: '10001', routes: [{ id: 'r', accept: { private: ['10001'], groups: [] }, memoryScope: 'gui' }] } })
  three.channel.start()
  await three.channel.handleEvent(privateEvent({ userId: 10001, text: '在吗' }))
  const recShared = [...three.channel.records.values()][0]
  assert.equal(canonScope(three.channel.scopeOf(recShared.sessionId)), 'gui', '配了 gui 就该落 gui')
  await three.channel.stop()

  pass('per-user：私聊落本人、群聊落群、配了 shared/gui 就听配置')
} finally {
  drop(ctx)
}
