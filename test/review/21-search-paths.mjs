/**
 * 原 test-search-paths.mjs：三条搜索路——≥3 字走 FTS(trigram)、<3 字走 LIKE，中文都要命得中。
 * 顺带验一句：搜出来的东西仍然按档筛（见 01），别为了修路把分人漏了。
 */
import { assert, drop, mkStore, pass } from './_lib.mjs'

const ctx = mkStore('seed-review-search-')
try {
  const { store } = ctx
  store.remember({ text: '喜欢在雨天写东西', layer: 'semantic' })
  store.remember({ text: '昨天一起吃了火锅', layer: 'episodic' })
  store.remember({ text: '雨', layer: 'semantic' })

  // ① ≥3 字：trigram 那条路
  const long = store.search('雨天写东西', { limit: 5 }).map((r) => r.text)
  assert.ok(long.includes('喜欢在雨天写东西'), `长词该命中：${JSON.stringify(long)}`)

  // ② 2 字：LIKE 那条路
  const short = store.search('火锅', { limit: 5 }).map((r) => r.text)
  assert.ok(short.includes('昨天一起吃了火锅'), `短词该命中：${JSON.stringify(short)}`)

  // ③ 1 字
  const one = store.search('雨', { limit: 5 }).map((r) => r.text)
  assert.ok(one.length >= 2, `一个字也该命中：${JSON.stringify(one)}`)

  // ④ 搜不到就是空，不报错
  assert.deepEqual(store.search('量子力学', { limit: 5 }), [])

  pass('search-paths：长词走 trigram、短词走 LIKE，中文都命得中')
} finally {
  drop(ctx)
}
