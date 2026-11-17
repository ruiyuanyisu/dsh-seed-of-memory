import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_GATE_TTL_SEC,
  MEMORY_SCOPES,
  defaultRoutes,
  isOrder,
  normalizeScope,
  orderFresh,
  routeOf,
  validateRoutes,
  workspaceTag,
} from '../lib/qq/routes.js'

const priv = (userId, text = '在吗') => ({
  post_type: 'message',
  message_type: 'private',
  user_id: userId,
  sender: { user_id: userId },
  raw_message: text,
  message: [{ type: 'text', data: { text } }],
  message_id: `m-${userId}-${text}`,
})

const group = (groupId, userId, text = '在吗') => ({
  post_type: 'message',
  message_type: 'group',
  group_id: groupId,
  user_id: userId,
  sender: { user_id: userId },
  raw_message: text,
  message: [{ type: 'text', data: { text } }],
  message_id: `gm-${groupId}-${userId}-${text}`,
})

test('没配 routes 时：一个号全收，cwd 用配置里的，不是宿主进程目录', () => {
  const routes = defaultRoutes('D:\\work')
  assert.equal(routes.length, 1)
  assert.equal(routes[0].id, 'main')
  assert.equal(routes[0].cwd, 'D:\\work')
  assert.equal(routes[0].memoryScope, 'qq', '默认档位得是我们认识的')
  const out = routeOf(priv('1'), { cwd: 'D:\\work' })
  assert.equal(out.allow, true)
  assert.equal(out.cwd, 'D:\\work')
})

test('accept 收谁：私聊看人、群看群号，onlyFor 只回一个人', () => {
  const config = {
    cwd: 'D:\\work',
    routes: [
      {
        id: 'tsuki',
        cwd: 'D:\\work\\tsuki',
        accept: { private: ['100000003'], groups: ['200000002'] },
        onlyFor: ['100000003'],
      },
    ],
  }
  assert.equal(routeOf(priv('100000003'), config).allow, true)
  assert.equal(routeOf(priv('999'), config).allow, false)
  assert.equal(routeOf(group('200000002', '100000003'), config).allow, true)
  assert.equal(routeOf(group('200000002', '777'), config).allow, false, 'onlyFor 对群里也管用')
  assert.equal(routeOf(group('200000001', '100000003'), config).allow, false)
})

test('等在指令上：没有 order 时拦下，有新鲜的 order 才放；默认 900 秒就过期', () => {
  const config = {
    cwd: 'D:\\work',
    routes: [{ id: 'main', accept: { private: ['*'], groups: ['*'] }, cwd: 'D:\\work' }],
    gateRules: [{ id: 'need-order', when: { from: '100000003' }, requireOrderFrom: '100000002' }],
  }
  const now = 1_800_000_000_000
  const blocked = routeOf(priv('100000003'), config, { now, orders: [] })
  assert.equal(blocked.allow, false)
  assert.equal(blocked.gated, true)
  assert.match(blocked.reason, /等 100000002 的指令/)

  const fresh = routeOf(priv('100000003'), config, {
    now,
    orders: [{ from: '100000002', routeId: 'main', at: now - 60_000 }],
  })
  assert.equal(fresh.allow, true)

  const stale = routeOf(priv('100000003'), config, {
    now,
    orders: [{ from: '100000002', routeId: 'main', at: now - (DEFAULT_GATE_TTL_SEC + 1) * 1000 }],
  })
  assert.equal(stale.allow, false, '过期的指令不算数')
  assert.equal(stale.gated, true)
})

test('orderFresh 自己也能用：按 routeId 和 ttl 过滤', () => {
  const orders = [
    { from: 'a', routeId: 'main', at: 1000 },
    { from: 'a', routeId: 'tsuki', at: 5000 },
  ]
  assert.equal(orderFresh(orders, { from: 'a', routeId: 'tsuki', now: 6000, ttlSec: 60 })?.at, 5000)
  assert.equal(orderFresh(orders, { from: 'a', routeId: 'main', now: 6000, ttlSec: 1 }), null)
  // ttlSec 写 0 = 「立刻过期」。以前 `if (ttl && …)` 把 0 当成「不限时」，语义正好反过来。
  assert.equal(orderFresh(orders, { from: 'a', routeId: 'tsuki', now: 6000, ttlSec: 0 }), null)
  assert.equal(orderFresh(orders, { from: 'b', now: 6000, ttlSec: 60 }), null)
})

test('形状写错不静默：给出 warnings、坏条目丢掉、不抛', () => {
  const bad = validateRoutes({
    cwd: 'D:\\work',
    routes: { main: { accept: { private: '*' } } },
    gateRules: 'nope',
    orderTriggers: '放她进来',
    defaultAccount: '100000004',
  })
  assert.ok(bad.warnings.length >= 3)
  assert.equal(bad.routes.length, 1, '退回默认路由')
  assert.equal(bad.gateRules.length, 0)
  assert.equal(bad.orderTriggers.length, 0)
  assert.ok(bad.warnings.some((line) => line.includes('defaultAccount')))

  const partial = validateRoutes({
    cwd: 'D:\\work',
    routes: [
      { id: 'ok', accept: { private: ['*'], groups: [] } },
      { id: 'broken', accept: 'oops' },
    ],
    gateRules: [{ id: 'no-from', when: {} }],
  })
  assert.equal(partial.routes.length, 2)
  assert.deepEqual(partial.routes[1].accept, { private: [], groups: [] })
  assert.ok(partial.warnings.some((line) => line.includes('accept')))
  assert.equal(partial.gateRules.length, 0, '没有 requireOrderFrom 的规则不会生效')
})

test('memoryScope 收成我们认识的三档，别的名字算 qq', () => {
  assert.deepEqual(MEMORY_SCOPES, ['shared', 'gui', 'qq'])
  assert.equal(normalizeScope('gui'), 'gui')
  assert.equal(normalizeScope('SHARED'), 'shared')
  assert.equal(normalizeScope('ws-shorekeeper-main:tsuki'), 'qq')
  assert.equal(normalizeScope(''), 'qq')
  const out = routeOf(priv('1'), {
    cwd: 'D:\\work',
    routes: [{ id: 'main', cwd: 'D:\\work', accept: { private: ['*'] }, memoryScope: 'ws-x:main' }],
  })
  assert.equal(out.memoryScope, 'qq')
})

test('isOrder 认指令句', () => {
  assert.equal(isOrder('放她进来吧', ['放她进来']), true)
  assert.equal(isOrder('让她说话', ['让她说话', '放她进来']), true)
  assert.equal(isOrder('今天吃什么', ['放她进来']), false)
  assert.equal(isOrder('', ['放她进来']), false)
})

test('workspaceTag 稳定且只留安全字符', () => {
  assert.equal(workspaceTag('F:\\守岸人\\workspace'), workspaceTag('f:/守岸人/workspace/'))
  assert.match(workspaceTag('D:\\work'), /^ws-[a-z0-9_-]+-[0-9a-f]{6}$/i)
  assert.equal(workspaceTag(''), 'ws-default')
})
