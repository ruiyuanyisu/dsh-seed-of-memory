/**
 * 原 test-scope-peruser.mjs：三个人各一条 + 一条共用的，用同一个字搜，
 * 各自只该看到「自己的 + 共用的」。
 * 接口差异：他的 scope 是会话 id，我的是 `qq:<号>` / `group:<群号>`，走 store.search({scope})。
 */
import { assert, drop, mkStore, pass } from './_lib.mjs'

const ctx = mkStore('seed-review-scope-')
try {
  const { store } = ctx
  const A = 'qq:10001'
  const B = 'qq:20002'
  const C = 'qq:30003'
  store.remember({ text: '喜欢在雨天写东西', layer: 'semantic', scope: A })
  store.remember({ text: '喜欢在半夜听雨', layer: 'semantic', scope: B })
  store.remember({ text: '喜欢蓝头发', layer: 'semantic', scope: C })
  store.remember({ text: '喜欢一起看海', layer: 'semantic', scope: 'shared' })

  const texts = (scope) => store.search('喜欢', { scope, limit: 10 }).map((row) => row.text)
  const a = texts(A)
  const b = texts(B)
  assert.deepEqual(a.sort(), ['喜欢一起看海', '喜欢在雨天写东西'].sort(), 'A 该看到自己那条和共用那条')
  assert.deepEqual(b.sort(), ['喜欢一起看海', '喜欢在半夜听雨'].sort(), 'B 不该看到 A 的')
  assert.ok(!texts(C).includes('喜欢在雨天写东西'), 'C 也不该看到 A 的')

  // 不传 scope 的老调用方（管理面、面板）行为不变：全都看得到
  assert.equal(store.search('喜欢', { limit: 10 }).length, 4, '不传 scope 时不该被筛掉')
  pass('scope-peruser：三个人各看各的，共用那条两边都看得见')
} finally {
  drop(ctx)
}
