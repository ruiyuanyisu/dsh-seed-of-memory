/**
 * 原 test-history-cross.mjs：复盘按人键各看各的。
 * 接口差异：他用 `group:gid@uid`（群按人切）；我的群档是整群 `group:<gid>`，
 * 所以这里用「群一个键 + 私聊一个键」验隔离；另外验 recap 的 who：
 * 群聊里不能把别人的话写成老大说的。
 */
import { assert, drop, QqHistory, mkStore, pass } from './_lib.mjs'
import { join } from 'node:path'

const ctx = mkStore('seed-review-history-')
try {
  const file = join(ctx.dir, 'qq-history.json')
  const history = new QqHistory(file, { maxTurns: 20, maxKeys: 5 })

  history.append('group:123456', { u: '张三：今天下雨了', a: '嗯，带伞' })
  history.append('private:10001', { u: '老大：我回来了', a: '欢迎回来' })

  const groupRecap = history.recap('group:123456', 6, '群里的人')
  const ownerRecap = history.recap('private:10001', 6)
  assert.ok(groupRecap.includes('张三：今天下雨了'), `群里的账该有群里的：${groupRecap}`)
  assert.ok(!groupRecap.includes('我回来了'), '群里的账不该带私聊那句')
  assert.ok(groupRecap.includes('群里的人：'), `群聊复盘不该一律冠「老大」：${groupRecap}`)
  assert.ok(ownerRecap.includes('老大：'), `私聊复盘还是冠老大：${ownerRecap}`)
  assert.ok(!ownerRecap.includes('张三'), '私聊的账不该带群里那句')

  // 存盘再读回来，还是各在各的键上
  history.flush()
  const again = new QqHistory(file, { maxTurns: 20, maxKeys: 5 })
  assert.ok(again.recap('group:123456', 6, '群里的人').includes('张三'), '重启后群里的账还在')

  pass('history-cross：复盘按键各看各的；群聊不冠「老大」')
} finally {
  drop(ctx)
}
