/**
 * 原 test-emotion-isolation.mjs：情绪记录按会话分；不传 scope 时（面板）看得见全部。
 * 接口差异：我的列叫 slot（不是 scope），函数是 recentEmotions(db, limit, slot)。
 */
import { assert, columns, drop, mkStore, pass, rows } from './_lib.mjs'
import { recentEmotions, recordEmotion } from '../../lib/affect.js'

const ctx = mkStore('seed-review-emotion-')
try {
  const { db } = ctx
  assert.ok(columns(db, 'emotions').includes('slot'), 'emotions 该有 slot 列')

  recordEmotion(db, { label: '高兴', valence: 0.7, arousal: 0.4, cause: 'A 说好话', slot: 'qq:10001' })
  recordEmotion(db, { label: '难过', valence: -0.7, arousal: 0.4, cause: 'B 说坏话', slot: 'qq:20002' })
  recordEmotion(db, { label: '平静', valence: 0.1, arousal: 0.2, cause: '本地会话', slot: 'gui' })

  const a = recentEmotions(db, 10, 'qq:10001')
  assert.equal(a.length, 1)
  assert.equal(a[0].cause, 'A 说好话')
  assert.equal(a[0].slot, 'qq:10001')

  // 面板/管理面：不传 slot 看全部
  assert.equal(recentEmotions(db, 10).length, 3, '不传 slot 时面板要看得见全部')
  assert.equal(rows(db, 'SELECT * FROM emotions').length, 3)

  pass('emotion-isolation：情绪条目按档分，不传 slot 时面板看全部')
} finally {
  drop(ctx)
}
