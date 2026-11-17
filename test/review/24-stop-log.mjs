/**
 * 原 test-stop-log.mjs：停机时手上有没处理完的事，不能静默消失。
 * 我这边不是「记一条 drop 日志」，而是：把还没发出去的那句记进会话账本（history.append），
 * 并把等回复的 waiter 全部 resolve 掉（不然那个 setTimeout 要挂到超时）。
 * 断言按我的真实行为写：pending 清空、账本里多一条、waiters 清空、日志里有痕迹。
 */
import { assert, drop, FakeClient, makeChannel, mkStore, pass, QqHistory } from './_lib.mjs'
import { join } from 'node:path'

const ctx = mkStore('seed-review-stop-')
try {
  const logs = []
  const history = new QqHistory(join(ctx.dir, 'qq-history.json'))
  const { channel } = makeChannel({
    config: { ownerQQ: '10001' },
    onLog: (entry) => logs.push(entry),
    history,
  })

  // 手动塞一条「攒着还没发」的话 + 一个在等回复的 waiter
  channel.pending.set('private:10001', {
    texts: ['那句还没说出去的话'],
    timer: setTimeout(() => {}, 60_000),
    at: Date.now(),
  })
  let resolved = null
  channel.waiters.set('session-x', {
    resolve(value) {
      resolved = value
      clearTimeout(this.timer)
    },
  })

  await channel.stop()

  assert.equal(channel.pending.size, 0, '停机后不该还挂着没发的话')
  assert.equal(channel.waiters.size, 0, '停机后不该还留着等回复的 waiter')
  assert.equal(resolved, '', '等回复的那头要被 resolve 掉，不能干等到超时')
  const recap = history.recap('private:10001', 6)
  assert.ok(recap.includes('那句还没说出去的话'), `没发出去的那句要记进账本：${recap}`)
  assert.ok(
    logs.some((e) => String(e.message ?? e.text ?? '').includes('停机')),
    `日志里该有痕迹：${JSON.stringify(logs.slice(0, 5))}`,
  )

  pass('stop-log：停机时没发出去的话进账本、waiter 被放行、日志留痕')
} finally {
  drop(ctx)
}
