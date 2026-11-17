import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../lib/db.js'
import { SeedStore } from '../lib/store.js'
import { visiblePrefixes, scopeFilter, visibleScopes } from '../lib/scope.js'

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), 'seed-'))
  const file = path.join(dir, 'seed.db')
  const db = openDatabase(file)
  const store = new SeedStore(db, { dbPath: file })
  return { store, db, dir }
}

function done(ctx) {
  ctx.db.close()
  rmSync(ctx.dir, { recursive: true, force: true })
}

test('前缀档只有一个来源：当面多看见匿名，别处一律不给', () => {
  assert.deepEqual(visiblePrefixes('gui'), ['qq:anon-'])
  assert.deepEqual(visiblePrefixes('me'), ['qq:anon-'])
  assert.deepEqual(visiblePrefixes('shared'), [])
  assert.deepEqual(visiblePrefixes('qq'), [])
  assert.deepEqual(visiblePrefixes('qq:10001'), [])
  assert.deepEqual(visiblePrefixes('group:20002'), [])
  // 名字列表里不该出现前缀档 —— 它进不来，才需要一个单独的函数
  for (const scope of ['gui', 'shared', 'qq', 'qq:10001', 'group:20002']) {
    for (const name of visibleScopes(scope)) assert.ok(!name.includes('anon'), `${scope} 的名字列表里混进了匿名档`)
  }
})

test('scopeFilter 用区间，不用 LIKE：LIKE 吃不到索引', () => {
  const mine = scopeFilter('scope', 'gui')
  assert.ok(!/LIKE/i.test(mine.sql), `还在用 LIKE：${mine.sql}`)
  assert.match(mine.sql, /scope >= 'qq:anon-'/)
  // 上界是「前缀 + \uffff」：比任何 ASCII 尾巴都大，不靠末字符是 '-' 这种巧合
  assert.ok(mine.sql.includes("'qq:anon-\uffff'"), '上界该是 prefix + \\uffff')
  assert.ok(!mine.sql.includes('LIKE'), '上界不该再用末字符 + 1 的写法')
  // 参数只跟着名字列表走，前缀是常量，不该往里塞
  assert.deepEqual(mine.params, ['shared', 'gui', 'qq'])
  // sharedOnly 是「只看共用的」，不许被匿名档破口
  const only = scopeFilter('scope', 'gui', { sharedOnly: true })
  assert.equal(only.sql, 'scope = ?')
  assert.deepEqual(only.params, ['shared'])
  // 别人那一档没有前缀档，SQL 不该凭空多条件
  assert.ok(!/anon/.test(scopeFilter('scope', 'qq:10001').sql))
})

test('匿名档当面看得见，别人看不见，边界之外的不算', () => {
  const ctx = fresh()
  const anon = ctx.store.remember({ layer: 'semantic', text: '有人问了个奇怪的问题没人认领', scope: 'qq:anon-a1b2c3' })
  // 边界外的两个：少一个字符的、以及第 9 位比 '.' 大的
  const short = ctx.store.remember({ layer: 'semantic', text: '少一横的那条不算匿名档', scope: 'qq:anon' })
  const over = ctx.store.remember({ layer: 'semantic', text: '大写那条落在区间外面', scope: 'qq:anonX9' })
  const guiRow = ctx.store.remember({ layer: 'semantic', text: '当面说的话', scope: 'gui' })
  const found = ctx.store.search('奇怪的问题', { scope: 'gui' })
  assert.deepEqual(found.map((row) => row.id), [anon.id], '当面该看得见匿名档那条')
  assert.equal(ctx.store.search('少一横', { scope: 'gui' }).length, 0, '没有短横的不是匿名档')
  assert.equal(ctx.store.search('大写', { scope: 'gui' }).length, 0, '区间外的也不该混进来')
  // 别人的私聊里，匿名档那条不该出现
  assert.equal(ctx.store.search('奇怪的问题', { scope: 'qq:10001' }).length, 0)
  assert.equal(ctx.store.search('当面说的话', { scope: 'qq:10001' }).length, 0, '当面自己的话也不给别人看')
  assert.equal(ctx.store.get(short.id).scope, 'qq:anon')
  assert.equal(ctx.store.get(over.id).scope, 'qq:anonX9')
  assert.equal(ctx.store.get(guiRow.id).scope, 'gui')
  done(ctx)
})

test('卡片和列表也照这条规则走：当面看得见匿名，别的地方看不见', () => {
  const ctx = fresh()
  ctx.store.remember({ layer: 'episodic', text: '匿名档里那条没人认领的事', scope: 'qq:anon-9999', importance: 1 })
  const card = ctx.store.card({ budget: 2000, scope: 'gui' })
  assert.match(card.text, /没人认领的事/)
  const other = ctx.store.card({ budget: 2000, scope: 'qq:10001' })
  assert.ok(!/没人认领的事/.test(other.text), '别人的卡里不该有匿名档的事')
  assert.equal(ctx.store.list({ limit: 10, scope: 'qq:10001' }).length, 0)
  assert.equal(ctx.store.list({ limit: 10, scope: 'gui' }).length, 1)
  done(ctx)
})
