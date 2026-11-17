/**
 * 原 test-all6-isolation.mjs：群里张三李四交替说话，六样东西各记各的——
 * 记忆 / 待记 / 情绪记录 / 连着骂的计数 / 熟人卡 / 未完话头。
 * 接口差异：
 *  - 他用 personKeyOf(record) 造 `group:gid@uid`（群档按人切），我用 `group:<gid>`（整群一个档），
 *    所以这里换成两个私聊的人来验「各记各的」——分人的语义一样，键不同。
 *  - 他没有「心情一份」的差别：我这边 mood 是身体，情绪条目才是分档的，所以第 3 项断言的是条目。
 */
import { assert, drop, mkStore, pass } from './_lib.mjs'
import { addCapture, captureLine, listCaptures } from '../../lib/capture.js'
import { recordEmotion, recentEmotions } from '../../lib/affect.js'
import { Qing } from '../../lib/qing.js'
import { setContact, getContact, contactLine } from '../../lib/contacts.js'
import { addLoose, looseLines } from '../../lib/loose.js'

const ctx = mkStore('seed-review-all6-')
try {
  const { db, store } = ctx
  const A = 'qq:10001'
  const B = 'qq:20002'
  const peerA = 'private:10001'
  const peerB = 'private:20002'

  // ① 记忆
  store.remember({ text: '张三喜欢猫', layer: 'semantic', scope: A })
  store.remember({ text: '李四喜欢狗', layer: 'semantic', scope: B })
  const aTexts = store.search('喜欢', { scope: A, limit: 10 }).map((r) => r.text)
  assert.deepEqual(aTexts, ['张三喜欢猫'], 'A 的记忆里不该有李四的狗')

  // ② 待记
  addCapture(db, { sessionId: 's-a', text: '张三下个月要去厦门', cue: 'new', slot: A })
  addCapture(db, { sessionId: 's-b', text: '李四下个月要搬家', cue: 'new', slot: B })
  assert.equal(listCaptures(db, { slot: A }).length, 1, '待记也要各记各的')
  const lineA = captureLine(db, { slot: A })
  assert.ok(lineA.includes('厦门'), `A 的待记该有自己那句：${lineA}`)
  assert.ok(!lineA.includes('搬家'), 'A 的待记不该带李四那句')

  // ③ 情绪条目
  recordEmotion(db, { label: '高兴', valence: 0.6, arousal: 0.4, cause: '张三夸我', slot: A })
  recordEmotion(db, { label: '难过', valence: -0.6, arousal: 0.4, cause: '李四骂我', slot: B })
  assert.equal(recentEmotions(db, 10, A).length, 1)
  assert.equal(recentEmotions(db, 10, A)[0].cause, '张三夸我')
  assert.equal(recentEmotions(db, 10, B)[0].cause, '李四骂我')

  // ④ 连着骂的计数：分人
  const qing = new Qing(db)
  const now = Date.now()
  qing.observe('你真笨', now, { slot: A })
  qing.observe('你真笨', now + 1000, { slot: A })
  // 别人的一句不算「第三句」
  const before = qing.streak(now + 2000, A).length
  qing.observe('你别闹', now + 2000, { slot: B })
  assert.equal(qing.streak(now + 2000, A).length, before, 'B 说话不该算进 A 的连骂')

  // ⑤ 熟人卡
  setContact(db, { key: peerA, name: '张三', likes: '猫' })
  setContact(db, { key: peerB, name: '李四', likes: '狗' })
  assert.equal(getContact(db, peerA).name, '张三')
  assert.ok(!contactLine(getContact(db, peerA)).includes('狗'), '张三的卡上不该有李四的喜好')

  // ⑥ 未完话头
  addLoose(db, { peer: peerA, ask: '张三问我要不要一起去厦门' })
  addLoose(db, { peer: peerB, ask: '李四问我要不要帮他搬家' })
  const looseA = looseLines(db, peerA).join('\n')
  assert.ok(looseA.includes('厦门') && !looseA.includes('搬家'), `话头也要各记各的：${looseA}`)

  pass('all6-isolation：记忆/待记/情绪/连骂/熟人卡/话头，六样各记各的')
} finally {
  drop(ctx)
}
