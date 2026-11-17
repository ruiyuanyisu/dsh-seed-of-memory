/**
 * 原 test-orders-restart.mjs：反面用例——命令没有活下去的时候，重启后安全门还会拦住。
 * 这里用的是「没有 historyFile、也没有 ordersFile」的情形：存不了盘，第二条命就该不认得。
 * 目的不是让功能坏，而是证明「能放行」确实是靠那份存盘，而不是别的巧合。
 */
import { assert, drop, makeChannel, mkStore, pass, privateEvent } from './_lib.mjs'

const ctx = mkStore('seed-review-orders-neg-')
try {
  const config = { ownerQQ: '10001', orderTriggers: ['放她进来'] }

  const first = makeChannel({ config })
  first.channel.start()
  await first.channel.handleEvent(privateEvent({ userId: 10001, text: '放她进来' }))
  await first.channel.stop()
  assert.equal(first.channel.orders.length, 1, '内存里该有一条')

  // 没有存盘路径 → 新实例是空的
  const second = makeChannel({ config })
  assert.equal(second.channel.orders.length, 0, '没有落盘就不该凭空记得')

  // 配了 ordersFile 就记得住（对照）
  const withFile = makeChannel({ config: { ...config, ordersFile: `${ctx.dir}/orders.json` } })
  withFile.channel.start()
  await withFile.channel.handleEvent(privateEvent({ userId: 10001, text: '放她进来' }))
  await withFile.channel.stop()
  const third = makeChannel({ config: { ...config, ordersFile: `${ctx.dir}/orders.json` } })
  assert.equal(third.channel.orders.length, 1, '配了 ordersFile 就该读回来')

  pass('orders-restart：没落盘就记不住——放行确实来自那份存盘')
} finally {
  drop(ctx)
}
