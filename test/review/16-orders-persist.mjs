/**
 * 原 test-orders-persist.mjs：「放她进来」这类指令要活过重启。
 * 我的实现：channel 把命令存到和 historyFile 同目录的 qq-orders.json（或配置 ordersFile）。
 * 这里走真路：老大发一句「放她进来」→ 存盘 → 新起一个实例（等价于重启）还认得。
 */
import { assert, drop, makeChannel, mkStore, pass, privateEvent } from './_lib.mjs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const ctx = mkStore('seed-review-orders-')
try {
  const historyFile = join(ctx.dir, 'qq-history.json')
  const config = { ownerQQ: '10001', historyFile, orderTriggers: ['放她进来'] }

  const first = makeChannel({ config })
  first.channel.start()
  await first.channel.handleEvent(privateEvent({ userId: 10001, text: '放她进来' }))
  await first.channel.stop()

  const ordersFile = join(ctx.dir, 'qq-orders.json')
  assert.ok(existsSync(ordersFile), `命令该存盘：${ordersFile}`)

  // 重启：新实例读得回来，面板上也看得见
  const second = makeChannel({ config })
  assert.equal(second.channel.orders.length, 1, `重启后该认得那条命令：${JSON.stringify(second.channel.orders)}`)
  assert.equal(second.channel.orders[0].from, '10001')
  assert.equal(second.channel.status().orders.length, 1)

  pass('orders-persist：命令存盘，重启后还认得（安全门不会自己把门关上）')
} finally {
  drop(ctx)
}
