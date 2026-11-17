/**
 * 原 test-end-to-end.mjs：从空库一路走到「两个人各记各的」。
 * 他验的是自己补丁的表/索引名（mood_scoped、idx_emotion_scope……），
 * 我这里按 1.5.0 的实际情况验：user_version 到位、v13 那五个索引在、
 * 两条线各记情绪、待记采纳后落在本人名下。
 */
import { assert, drop, hasIndex, mkStore, one, pass, SCHEMA } from './_lib.mjs'
import { recordEmotion, recentEmotions } from '../../lib/affect.js'
import { acceptCapture, addCapture, listCaptures } from '../../lib/capture.js'

const ctx = mkStore('seed-review-e2e-')
try {
  const { db, store } = ctx

  // ① 库版本
  assert.equal(one(db, 'PRAGMA user_version').user_version, SCHEMA, `user_version 该是 ${SCHEMA}`)

  // ② v13 的五个索引都在
  for (const name of [
    'idx_beliefs_scope',
    'idx_captures_slot',
    'idx_emotions_slot',
    'idx_affects_slot',
    'idx_memories_scope',
  ]) {
    assert.ok(hasIndex(db, name), `缺索引 ${name}`)
  }

  // ③ 两条线各记情绪
  recordEmotion(db, { label: '高兴', valence: 0.6, arousal: 0.3, cause: '老大夸我', slot: 'qq:10001' })
  recordEmotion(db, { label: '烦', valence: -0.4, arousal: 0.5, cause: '张三一直催', slot: 'qq:20002' })
  assert.equal(recentEmotions(db, 5, 'qq:10001')[0].cause, '老大夸我')
  assert.equal(recentEmotions(db, 5, 'qq:20002')[0].cause, '张三一直催')

  // ④ 待记 → 采纳 → 落在那个人名下
  addCapture(db, { sessionId: 's1', text: '张三说他养了一只橘猫', cue: 'new', slot: 'qq:20002' })
  const pending = listCaptures(db, { slot: 'qq:20002' })
  assert.equal(pending.length, 1)
  const res = acceptCapture(db, store, pending[0].id)
  assert.equal(store.get(res.id).scope, 'qq:20002', '采纳后该记在张三名下')
  assert.equal(listCaptures(db, { slot: 'qq:20002' }).length, 0, '采纳完就不该再挂着')

  // ⑤ 老大那边看不到张三的猫
  assert.equal(store.search('橘猫', { scope: 'qq:10001', limit: 5 }).length, 0)
  assert.equal(store.search('橘猫', { scope: 'qq:20002', limit: 5 }).length, 1)

  pass('end-to-end：库版本/索引到位，两条线各记各的，待记采纳后落在本人名下')
} finally {
  drop(ctx)
}
