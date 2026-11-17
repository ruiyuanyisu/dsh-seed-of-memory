/**
 * 原 test-inject-break.mjs：库被搞坏（表被删掉）时，读心情/读情绪这些函数抛不抛。
 * 这些函数站在注入链的最里层，一抛就把整张记忆卡带走，所以只能降级不能炸。
 */
import { assert, drop, mkStore, pass } from './_lib.mjs'
import { affectLine, currentMood, recentEmotions, recordEmotion } from '../../lib/affect.js'
import { qingLine, Qing } from '../../lib/qing.js'

const ctx = mkStore('seed-review-break-')
try {
  const { db } = ctx
  const now = Date.now()

  // ① mood 表没了：currentMood 要给一个「平静」的默认值，不抛
  db.exec('DROP TABLE mood')
  const mood = currentMood(db, now)
  assert.ok(mood && typeof mood.label === 'string', `currentMood 该降级：${JSON.stringify(mood)}`)

  // ② emotions 表没了：recentEmotions 给空数组，不抛
  db.exec('DROP TABLE emotions')
  assert.deepEqual(recentEmotions(db, 5, 'gui'), [])

  // ③ affects 表没了：affectLine 给空串，不抛
  db.exec('DROP TABLE affects')
  const line = affectLine(db, { slot: 'gui', now })
  assert.equal(typeof line?.line, 'string', 'affectLine 该给一个空的 line，而不是抛')

  // ④ qing_state 表没了：快照还得能读（qing 自己兜底）
  db.exec('DROP TABLE qing_state')
  const qing = new Qing(db)
  const snap = qing.snapshot(now, 'gui')
  assert.ok(snap && typeof snap.mood === 'number', `qing.snapshot 该降级：${JSON.stringify(snap)}`)
  assert.equal(typeof qingLine(snap, now, {}, 'gui'), 'string')

  pass('inject-break：表被删也不会抛——心情/情绪/关系账/体温各自降级')
} finally {
  drop(ctx)
}
