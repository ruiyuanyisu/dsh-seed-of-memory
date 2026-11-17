import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../lib/db.js'
import { SeedStore, charLen } from '../lib/store.js'

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

test('insert and read back', () => {
  const ctx = fresh()
  const { id, action } = ctx.store.remember({
    layer: 'semantic',
    text: '她养的鲸鱼叫小忆',
    factKey: '她.宠物',
  })
  assert.equal(action, 'inserted')
  const row = ctx.store.get(id)
  assert.equal(row.layer, 'semantic')
  assert.equal(row.status, 'active')
  assert.ok(row.valid_from > 0)
  done(ctx)
})

test('same text merges instead of duplicating', () => {
  const ctx = fresh()
  const a = ctx.store.remember({ layer: 'episodic', text: '今天她录了三段语音' })
  const b = ctx.store.remember({ layer: 'episodic', text: '今天她录了三段语音' })
  assert.equal(b.action, 'merged')
  assert.equal(a.id, b.id)
  assert.equal(ctx.store.list({ layer: 'episodic' }).length, 1)
  done(ctx)
})

test('fact key change retires the old row and links it', () => {
  const ctx = fresh()
  const a = ctx.store.remember({ layer: 'semantic', text: '她的音色叫雨晶', factKey: '她.音色名' })
  const b = ctx.store.remember({ layer: 'semantic', text: '她的音色叫小忆', factKey: '她.音色名' })
  assert.equal(b.action, 'superseded')
  const oldRow = ctx.store.get(a.id)
  assert.equal(oldRow.status, 'retired')
  assert.equal(oldRow.superseded_by, b.id)
  assert.ok(oldRow.valid_to > 0)
  assert.equal(ctx.store.get(b.id).status, 'active')
  const chain = ctx.store.chain(a.id)
  assert.equal(chain.length, 2)
  done(ctx)
})

test('同一个事实键前后多打了空格，也算同一件事', () => {
  const ctx = fresh()
  const a = ctx.store.remember({ layer: 'semantic', text: '他怕冷', factKey: '他.怕冷', source: 'user-said' })
  const b = ctx.store.remember({ layer: 'semantic', text: '他真的很怕冷', factKey: '  他.怕冷  ', source: 'user-said' })
  assert.equal(b.action, 'superseded')
  assert.equal(ctx.store.get(a.id).superseded_by, b.id)
  const sameKey = ctx.store.list({ includeRetired: false, limit: 20 }).filter((row) => row.fact_key === '他.怕冷')
  assert.equal(sameKey.length, 1)
  done(ctx)
})

test('他说了新的，就按新的来；旧条退场留链', () => {
  const ctx = fresh()
  const a = ctx.store.remember({
    layer: 'semantic', text: '他喜欢夜里听雨', factKey: '他.偏好.雨', source: 'user-said',
  })
  const b = ctx.store.remember({
    layer: 'semantic', text: '他现在更喜欢早上听雨', factKey: '他.偏好.雨', source: 'user-said',
  })
  assert.equal(b.action, 'superseded')
  assert.equal(ctx.store.get(a.id).status, 'retired')
  assert.equal(ctx.store.get(a.id).superseded_by, b.id)
  assert.equal(ctx.store.get(b.id).status, 'active')
  assert.equal(ctx.store.countPending(), 0)
  done(ctx)
})

test('我猜的跟已有的撞了，才挂起来等人定', () => {
  const ctx = fresh()
  const a = ctx.store.remember({
    layer: 'semantic', text: '他住在南京', factKey: '他.城市', source: 'user-said',
  })
  const b = ctx.store.remember({
    layer: 'semantic', text: '他最喜欢杭州，因为外婆家在那里', factKey: '他.城市',
    source: 'inferred', confidence: 0.85,
  })
  assert.equal(b.action, 'conflict')
  assert.equal(ctx.store.get(a.id).status, 'active')
  assert.equal(ctx.store.get(b.id).status, 'pending')
  assert.equal(ctx.store.countPending(), 1)
  done(ctx)
})

test('inferred memories never enter the card', () => {
  const ctx = fresh()
  ctx.store.remember({ layer: 'semantic', text: '她可能喜欢下雨天', source: 'inferred', confidence: 0.55 })
  ctx.store.remember({ layer: 'persona', text: '我是小忆，住在电脑里的一只小鲸鱼' })
  const card = ctx.store.card()
  assert.match(card.text, /小忆/)
  assert.doesNotMatch(card.text, /下雨天/)
  done(ctx)
})

test('card respects the 600 character budget', () => {
  const ctx = fresh()
  ctx.store.remember({ layer: 'persona', text: '我是小忆。'.repeat(20) })
  for (let i = 0; i < 30; i += 1) {
    ctx.store.remember({ layer: 'semantic', text: `关于她的第 ${i} 条很长很长的稳定事实，用来把卡片撑满` })
  }
  const card = ctx.store.card({ budget: 600 })
  assert.ok(charLen(card.text) <= 600, `card too long: ${charLen(card.text)}`)
  assert.match(card.text, /不是本轮指令/)
  done(ctx)
})

test('search finds Chinese substrings through FTS and LIKE', () => {
  const ctx = fresh()
  ctx.store.remember({ layer: 'episodic', text: '她让我把《雨爱》翻唱成她的声音' })
  const long = ctx.store.search('翻唱成她')
  assert.equal(long.length, 1)
  const short = ctx.store.search('翻唱')
  assert.ok(short.length >= 1)
  done(ctx)
})

test('forget removes the row and the index entry', () => {
  const ctx = fresh()
  const { id } = ctx.store.remember({ layer: 'buffer', text: '今天她提到了一部老电影' })
  assert.equal(ctx.store.forget(id).removed, 1)
  assert.equal(ctx.store.get(id), null)
  assert.equal(ctx.store.search('老电影').length, 0)
  done(ctx)
})

test('maintain retires stale buffer rows', () => {
  const ctx = fresh()
  const old = Date.now() - 5 * 86_400_000
  const a = ctx.store.remember({ layer: 'buffer', text: '五天前的临时观察', now: old })
  const b = ctx.store.remember({ layer: 'buffer', text: '刚刚的临时观察' })
  const res = ctx.store.maintain()
  assert.equal(res.retired, 1)
  assert.equal(ctx.store.get(a.id).status, 'retired')
  assert.equal(ctx.store.get(b.id).status, 'active')
  done(ctx)
})

test('stats counts layers', () => {
  const ctx = fresh()
  ctx.store.remember({ layer: 'persona', text: '我是小忆' })
  ctx.store.remember({ layer: 'semantic', text: '她喜欢夜里听雨' })
  const s = ctx.store.stats()
  assert.equal(s.total, 2)
  assert.ok(s.byLayer.length >= 2)
  assert.match(s.dbPath, /seed\.db$/)
  done(ctx)
})

test('mood bias prefers same-valence memories', () => {
  const ctx = fresh()
  ctx.store.remember({ text: '她今天笑得很开心', layer: 'semantic', emotion: '开心', importance: 0.5 })
  ctx.store.remember({ text: '她那天很难过', layer: 'semantic', emotion: '难过', importance: 0.5 })
  const happy = ctx.store.search('', { bias: { valence: 0.6, weight: 0.15, valenceOf: (l) => (l === '开心' ? 0.8 : l === '难过' ? -0.6 : null) } })
  assert.equal(happy[0].emotion, '开心')
  const sad = ctx.store.search('', { bias: { valence: -0.6, weight: 0.15, valenceOf: (l) => (l === '开心' ? 0.8 : l === '难过' ? -0.6 : null) } })
  assert.equal(sad[0].emotion, '难过')
  done(ctx)
})

test('card ordering follows mood bias', () => {
  const ctx = fresh()
  ctx.store.remember({ text: '她今天笑得很开心', layer: 'semantic', emotion: '开心', importance: 0.5 })
  ctx.store.remember({ text: '她那天很难过', layer: 'semantic', emotion: '难过', importance: 0.5 })
  const valenceOf = (l) => (l === '开心' ? 0.8 : l === '难过' ? -0.6 : null)
  const happyCard = ctx.store.card({ bias: { valence: 0.7, weight: 0.15, valenceOf } }).text
  const sadCard = ctx.store.card({ bias: { valence: -0.7, weight: 0.15, valenceOf } }).text
  assert.ok(happyCard.indexOf('笑得很开心') < happyCard.indexOf('那天很难过'))
  assert.ok(sadCard.indexOf('那天很难过') < sadCard.indexOf('笑得很开心'))
  done(ctx)
})

test('卡片遇到坏时间戳和空记录也不写 NaN', () => {
  const ctx = fresh()
  ctx.store.remember({ text: '一条正常的记忆', layer: 'episodic', importance: 0.6 })
  // 坏时间戳（老版本或手改库才可能出现）：不能把 NaN-NaN 写进卡片
  ctx.db.exec(`UPDATE memories SET recorded_at = 'oops', occurred_at = 'oops'`)
  const card = ctx.store.card({ budget: 600 }).text
  assert.ok(card.includes('一条正常的记忆'), card)
  assert.ok(!/NaN/.test(card), card)
  // 空正文记录不该占一行
  ctx.db.exec(
    `INSERT INTO memories (id, layer, text, norm, source, confidence, importance, valid_from, recorded_at, status, scope, meta)
     VALUES ('empty-row', 'episodic', '   ', 'e', 'user-said', 0.5, 0.5, 0, 1794577299240, 'active', 'shared', '{}')`,
  )
  const card2 = ctx.store.card({ budget: 600 }).text
  assert.ok(!card2.split('\n').some((line) => line.trim() === '-'), card2)
  assert.ok(!/NaN/.test(card2), card2)
  done(ctx)
})
test('挂起的也能定下来：keep 之后转正、旧的退场留链', () => {
  const ctx = fresh()
  const a = ctx.store.remember({
    layer: 'semantic', text: '他住在南京', factKey: '他.城市', source: 'user-said',
  })
  const b = ctx.store.remember({
    layer: 'semantic', text: '他其实常年在杭州，外婆家在那儿', factKey: '他.城市',
    source: 'inferred', confidence: 0.85,
  })
  assert.equal(b.action, 'conflict')
  assert.equal(ctx.store.countPending(), 1)

  const promoted = ctx.store.promotePending(b.id)
  assert.equal(promoted.status, 'active')
  const old = ctx.store.get(a.id)
  assert.equal(old.status, 'retired')
  assert.equal(old.superseded_by, b.id)
  assert.equal(ctx.store.countPending(), 0)

  // 已经不是 pending 了，再 keep 一次不该有任何动作
  assert.equal(ctx.store.promotePending(b.id), null)
  done(ctx)
})
test('一条超长记忆不该把整张卡挡空', () => {
  const ctx = fresh()
  const now = Date.now()
  // 最新那条是粘进来的一整篇长文；后面两件事仍然要看得到
  ctx.store.remember({ layer: 'episodic', text: '雨'.repeat(2000), source: 'user-said', now: now - 3000 })
  ctx.store.remember({ layer: 'episodic', text: '他今天把话说软了一点', source: 'user-said', now: now - 2000 })
  ctx.store.remember({ layer: 'episodic', text: '他喜欢夜里听雨', source: 'user-said', now: now - 1000 })
  const card = ctx.store.card({ budget: 600 })
  assert.match(card.text, /他喜欢夜里听雨/)
  assert.match(card.text, /把话说软了一点/)
  assert.ok(!card.text.includes('雨雨雨雨'), '超长那条不该整篇贴上卡')
  assert.ok(card.text.length <= 600)
  done(ctx)
})

test('插入半途失败时整条退掉，不留「列表里有、搜索搜不到」的半截', () => {
  const ctx = fresh()
  const count = () => Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n)
  const before = count()
  const ftsSql = ctx.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_fts'").get()?.sql
  ctx.db.exec('DROP TABLE memories_fts')
  ctx.db.exec('CREATE TABLE memories_fts (wrong_column TEXT)')
  assert.throws(() => ctx.store.remember({ layer: 'episodic', text: '这条应该整条退掉' }))
  assert.equal(count(), before, '主表不该留下半条')
  ctx.db.exec('DROP TABLE memories_fts')
  if (ftsSql) ctx.db.exec(ftsSql)
  done(ctx)
})

test('替换旧记录失败时，旧的那条不能已经被退场', () => {
  const ctx = fresh()
  const kept = ctx.store.remember({ layer: 'semantic', text: '他的生日在三号', factKey: '他.生日' })
  ctx.db.exec('DROP TABLE memories_fts')
  ctx.db.exec('CREATE TABLE memories_fts (wrong_column TEXT)')
  assert.throws(() => ctx.store.remember({ layer: 'semantic', text: '他的生日改到十四号', factKey: '他.生日' }))
  const still = ctx.store.get(kept.id)
  assert.equal(still?.status, 'active', '只退不进就等于把这条记忆弄丢了')
  ctx.db.exec('DROP TABLE memories_fts')
  ctx.db.exec('CREATE TABLE memories_fts (id TEXT PRIMARY KEY, text TEXT)')
  done(ctx)
})

test('当面说的不跑到别人的私聊里，共用的两边都看得见', () => {
  const ctx = fresh()
  ctx.store.remember({ layer: 'semantic', text: '他喜欢夜里听雨', scope: 'gui' })
  ctx.store.remember({ layer: 'semantic', text: '我们约好寒假讲故事', scope: 'shared' })
  ctx.store.remember({ layer: 'semantic', text: '张三在厂里上夜班', scope: 'qq:10001' })

  const gui = ctx.store.search('夜', { scope: 'gui' }).map((r) => r.text)
  assert.deepEqual(gui, ['他喜欢夜里听雨'], '当面这条是自己的，别人的不该进来')

  const own = ctx.store.search('夜', { scope: 'qq:10001' }).map((r) => r.text)
  assert.deepEqual(own, ['张三在厂里上夜班'], '自己的私聊看自己的')
  assert.ok(!own.includes('他喜欢夜里听雨'), 'gui 档不该漏到 QQ 上')

  const stranger = ctx.store.search('夜', { scope: 'qq:20002' }).map((r) => r.text)
  assert.deepEqual(stranger, [], '另一个人不该看见张三说的话')

  const shared = ctx.store.search('寒假', { scope: 'qq:20002' }).map((r) => r.text)
  assert.deepEqual(shared, ['我们约好寒假讲故事'], '共用的到哪都看得见')

  assert.ok(ctx.store.card({ scope: 'qq:20002' }).text.includes('我们约好寒假讲故事'))
  assert.ok(!ctx.store.card({ scope: 'qq:20002' }).text.includes('他喜欢夜里听雨'))
  done(ctx)
})

test('老 qq 桶只剩「当面」看得见：私聊和群都不再自动读它', () => {
  const ctx = fresh()
  // 1.4.x 时代写下的群/私聊记忆：scope = 'qq'，里面混着好几个人的话
  ctx.store.remember({ layer: 'semantic', text: '老大十一月换了键盘', scope: 'qq' })
  const seen = ctx.store.search('键盘', { scope: 'gui' }).map((r) => r.text)
  assert.deepEqual(seen, ['老大十一月换了键盘'], '当面还看得见旧账，升级不至于失忆')

  const stranger = ctx.store.search('键盘', { scope: 'qq:10001' }).map((r) => r.text)
  assert.deepEqual(stranger, [], '别人的私聊不再读得到老桶 —— 那桶里混着别人的话')
  const group = ctx.store.search('键盘', { scope: 'group:20002' }).map((r) => r.text)
  assert.deepEqual(group, [], '群也一样')

  // 老桶读不到了，也就不该再被谁接管：写自己的档，老条原样留着
  const r = ctx.store.remember({
    layer: 'semantic',
    text: '老大十一月换了静音键盘',
    factKey: '老大.键盘',
    scope: 'qq:10001',
  })
  assert.equal(r.action, 'inserted')
  assert.equal(ctx.store.get(r.id).scope, 'qq:10001')
  const legacy = ctx.db.prepare("SELECT status FROM memories WHERE scope = 'qq'").all()
  assert.deepEqual(legacy.map((row) => row.status), ['active'], '老桶那条没被动')
  done(ctx)
})

test('当面把共用层的事再说一遍：不新建第二条，改的是那一条', () => {
  const ctx = fresh()
  const first = ctx.store.remember({ layer: 'semantic', text: '他叫阿甲', factKey: '他.名字', scope: 'shared' })
  const second = ctx.store.remember({ layer: 'semantic', text: '他叫阿乙', factKey: '他.名字', scope: 'gui' })
  assert.equal(second.action, 'superseded')
  assert.equal(ctx.store.get(first.id).status, 'retired', 'shared 那条退场')
  assert.equal(ctx.store.get(second.id).scope, 'shared', '新那条还是共用层的：QQ 那边也得看见')
  const active = ctx.db
    .prepare("SELECT scope, text FROM memories WHERE fact_key = '他.名字' AND status = 'active'")
    .all()
  assert.deepEqual(active.map((row) => [row.scope, row.text]), [['shared', '他叫阿乙']], '卡片里只会有一个版本')
  assert.ok(ctx.store.card({ scope: 'qq:10001' }).text.includes('他叫阿乙'), '别人那边也看到改过之后的版本')
  done(ctx)
})

test('同键撞车只在同一个档里算：别人的账我来改不了', () => {
  const ctx = fresh()
  const mine = ctx.store.remember({
    layer: 'semantic',
    text: '我住在城东',
    factKey: '我.住处',
    scope: 'gui',
    confidence: 0.95,
  })
  // 另一个人的私聊里说了同一个键：不该把当面那条退掉
  ctx.store.remember({
    layer: 'semantic',
    text: '我住在城西',
    factKey: '我.住处',
    source: 'inferred',
    confidence: 0.9,
    scope: 'qq:10001',
  })
  assert.equal(ctx.store.get(mine.id).status, 'active')
  const active = ctx.db
    .prepare("SELECT scope, count(*) AS n FROM memories WHERE fact_key = '我.住处' AND status = 'active' GROUP BY scope")
    .all()
  assert.deepEqual(active.map((r) => [r.scope, Number(r.n)]), [['gui', 1], ['qq:10001', 1]])
  done(ctx)
})


test('搜索也只搜看得见的：别人私聊里说的，不会从这边被搜出来', () => {
  const ctx = fresh()
  const { store } = ctx
  store.remember({ text: '他养了一只橘猫', layer: 'semantic', scope: 'qq:10001' })
  store.remember({ text: '他怕冷，冬天要穿两层', layer: 'semantic', scope: 'qq:20002' })
  store.remember({ text: '他喜欢深夜写代码', layer: 'semantic', scope: 'shared' })

  const mine = store.search('他', { limit: 10, scope: 'qq:10001' }).map((row) => row.text)
  assert.ok(mine.some((t) => t.includes('橘猫')))
  assert.ok(!mine.some((t) => t.includes('两层')), '别人的私事不该出来')
  assert.ok(mine.some((t) => t.includes('深夜')), '共用的照样看得见')

  const gui = store.search('他', { limit: 10, scope: 'gui' }).map((row) => row.text)
  assert.ok(!gui.some((t) => t.includes('橘猫')), '当面这一档不带 QQ 私聊的东西')
  assert.ok(gui.some((t) => t.includes('深夜')))

  // 不传 scope 的老调用方（管理面/导出）还是全库
  assert.ok(store.search('他', { limit: 10 }).length >= 3)
  done(ctx)
})

test('同键撞车看得见：正常 0 条，手工造出两条 active 就能报出来', () => {
  const ctx = fresh()
  const { store, db } = ctx
  assert.deepEqual(store.sameKeyConflicts(), [])

  // 正常路径：同一个键说两遍，旧的那条会退场，不该留下两条 active
  store.remember({ text: '他喜欢喝美式', layer: 'semantic', factKey: '他.咖啡', scope: 'gui' })
  store.remember({ text: '他改喝手冲了', layer: 'semantic', factKey: '他.咖啡', scope: 'gui' })
  assert.deepEqual(store.sameKeyConflicts(), [], '正常替换不该算撞车')

  // 手工绕过退场逻辑造一份，模拟「某条路没走 factKey 分支」
  const base = store.remember({ text: '他喜欢喝美式', layer: 'semantic', factKey: '他.咖啡', scope: 'shared' })
  assert.ok(base?.id)
  db.prepare(`UPDATE memories SET status = 'active' WHERE id = ?`).run(base.id)
  db.prepare(`UPDATE memories SET status = 'active' WHERE fact_key = ? AND id <> ?`).run('他.咖啡', base.id)

  const clashes = store.sameKeyConflicts()
  assert.equal(clashes.length, 1)
  assert.equal(clashes[0].factKey, '他.咖啡')
  assert.ok(Number(clashes[0].n) >= 2)
  done(ctx)
})

test('listExact 只认那一档，不像 list 那样把共用层带出来', () => {
  const ctx = fresh()
  const { store } = ctx
  store.remember({ text: '他喜欢喝美式', layer: 'semantic', scope: 'shared' })
  store.remember({ text: '别人说他最近爱喝美式', layer: 'episodic', scope: 'qq:100000002' })

  // list({ scope }) 是「以这个视角能看到的」，会把 shared 一起带出来
  assert.equal(store.list({ scope: 'qq:100000002' }).length, 2, '视角可见的应当含共用层')

  // listExact 问的是「这一档里到底存了什么」
  const exact = store.listExact('qq:100000002')
  assert.equal(exact.length, 1)
  assert.equal(exact[0].scope, 'qq:100000002')
  assert.equal(store.listExact('qq:100000009').length, 0)
  done(ctx)
})

test('moveScope 能搬档，同键的旧说法会退场留链', () => {
  const ctx = fresh()
  const { store, db } = ctx
  const mine = store.remember({ text: '他喜欢喝美式', layer: 'semantic', factKey: '他.咖啡', scope: 'gui' })
  assert.ok(mine?.id)

  // 新档里已经有一条同键的（模拟以前别人说过一遍）
  const other = store.remember({ text: '那个人爱喝美式', layer: 'semantic', factKey: '他.咖啡', scope: 'qq:100000002' })
  assert.ok(other?.id)
  db.prepare(`UPDATE memories SET status = 'active' WHERE id = ?`).run(other.id)

  const moved = store.moveScope(mine.id, 'shared')
  assert.equal(moved.ok, true)
  assert.equal(moved.row.scope, 'shared')
  // 搬进 shared 时，qq 档那条同键的不该被误退（不同档，撞不上）
  assert.equal(store.get(other.id).status, 'active')

  // 搬回 qq 档：这时才和那条同键的撞上，旧的退场
  const back = store.moveScope(mine.id, 'qq:100000002')
  assert.equal(back.ok, true)
  assert.equal(back.retired.length, 1)
  assert.equal(store.get(other.id).status, 'retired')
  assert.equal(store.get(other.id).superseded_by, mine.id)

  assert.equal(store.moveScope(mine.id, 'shared').row.scope, 'shared')
  assert.equal(store.moveScope('nope', 'shared').ok, false)
  done(ctx)
})

test('lineage 能把一个键的整条时间线排出来，没键的就它自己一条', () => {
  const ctx = fresh()
  const { store } = ctx
  const first = store.remember({ text: '他喜欢喝美式', layer: 'semantic', factKey: '他.咖啡', scope: 'gui' })
  const second = store.remember({ text: '他改喝手冲了', layer: 'semantic', factKey: '他.咖啡', scope: 'gui' })
  assert.ok(first?.id && second?.id)

  const traced = store.lineage(second.id)
  assert.equal(traced.key, '他.咖啡')
  assert.equal(traced.chain.length, 2)
  assert.equal(traced.chain[0].status, 'retired', '旧的那条应当退场')
  assert.equal(traced.chain.at(-1).status, 'active', '新的那条还活着')
  assert.equal(traced.chain.at(-1).id, second.id)

  // 没有事实键的：只有自己一条，说明它是一次性的记录
  const solo = store.remember({ text: '今天下了半天雨', layer: 'episodic', scope: 'gui' })
  const one = store.lineage(solo.id)
  assert.equal(one.key, '')
  assert.deepEqual(one.chain.map((row) => row.id), [solo.id])

  assert.equal(store.lineage('nope'), null)
  done(ctx)
})


test('lineage 只排我看得见的那几档：别人档里的话不会被拖出来', () => {
  const ctx = fresh()
  const { store } = ctx
  // 同一个键，两个人在各自私聊里各记了一份
  const mine = store.remember({ text: '他养了一只猫', layer: 'semantic', factKey: '他.宠物', scope: 'qq:100000002' })
  const other = store.remember({ text: '他养了两只猫', layer: 'semantic', factKey: '他.宠物', scope: 'qq:100000003' })
  const traced = store.lineage(mine.id, { scope: 'qq:100000002' })
  assert.equal(traced.chain.length, 1, '不该把别人那一档的同键记忆排进来')
  assert.equal(traced.chain[0].id, mine.id)
  // 不传 scope 的还是全库（管理面、迁移用）
  assert.equal(store.lineage(mine.id).chain.length, 2)
  // 共用层的同键记忆两边都看得见
  const shared = store.remember({ text: '他早上六点起', layer: 'semantic', factKey: '他.作息', scope: 'shared' })
  assert.equal(store.lineage(shared.id, { scope: 'qq:100000002' }).chain.length, 1)
  done(ctx)
})

test('搬到同一句话已经在的那一档：留刚搬来的那条，原来那条退场留链', () => {
  const ctx = fresh()
  const { store } = ctx
  const here = store.remember({ text: '他喜欢夜里听雨', layer: 'semantic', factKey: '他.偏好.雨', scope: 'qq:100000002' })
  const there = store.remember({ text: '他喜欢夜里听雨', layer: 'semantic', factKey: '他.偏好.天气', scope: 'qq:100000003' })
  const moved = store.moveScope(here.id, 'qq:100000003')
  assert.equal(moved.ok, true, JSON.stringify(moved))
  assert.equal(store.get(here.id).scope, 'qq:100000003')
  assert.equal(store.get(here.id).status, 'active')
  assert.equal(store.get(there.id).status, 'retired', '原来那条要退场，不能并排两份 active')
  assert.equal(store.get(there.id).superseded_by, here.id)
  assert.deepEqual(moved.retired, [there.id])
  done(ctx)
})

test('同键撞车按档算：两个人在各自档里各有主张，不算撞车', () => {
  const ctx = fresh()
  const { store, db } = ctx
  store.remember({ text: '他养了一只猫', layer: 'semantic', factKey: '他.宠物', scope: 'qq:100000002' })
  store.remember({ text: '他养了两只猫', layer: 'semantic', factKey: '他.宠物', scope: 'qq:100000003' })
  assert.deepEqual(store.sameKeyConflicts(), [], '不同档各有各的说法不算撞车')

  // 同一档里手工再造一条 active，模拟「某条路没走退场逻辑」
  const at = Date.now()
  db.prepare(
    `INSERT INTO memories (id, layer, text, norm, source, scope, status, fact_key, valid_from, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
  ).run('m_dup_152', 'semantic', '他又养了一只', '他又养了一只', 'user-said', 'qq:100000002', '他.宠物', at, at)
  const clashes = store.sameKeyConflicts()
  assert.equal(clashes.length, 1)
  assert.equal(clashes[0].scope, 'qq:100000002')
  assert.equal(clashes[0].n, 2)
  done(ctx)
})


test('先别提：记着，但这段时间不进卡片，search 还查得到', () => {
  const ctx = fresh()
  const one = ctx.store.remember({ layer: 'episodic', text: '他说今天有点烦，先别问', importance: 1, scope: 'gui' })
  ctx.store.remember({ layer: 'episodic', text: '周末想去山里看雾', importance: 1, scope: 'gui' })
  const muted = ctx.store.setMute(one.id, Date.now() + 7 * 86_400_000)
  assert.equal(muted.ok, true)
  assert.ok(muted.muteUntil > Date.now())

  const card = ctx.store.card({ budget: 2000, scope: 'gui' })
  assert.ok(!/先别问/.test(card.text), '先别提的不该进卡片')
  assert.match(card.text, /山里/)

  // search / open 不走卡片：还是查得到。「别提」和「忘掉」是两件事。
  assert.equal(ctx.store.search('先别问', { scope: 'gui' }).length, 1)
  assert.equal(ctx.store.listMuted().length, 1)

  // 到期自己回来，不用谁去点一下
  const later = Date.now() + 8 * 86_400_000
  assert.match(ctx.store.card({ budget: 2000, scope: 'gui', now: later }).text, /先别问/)
  assert.equal(ctx.store.listMuted(later).length, 0)

  // off 就是立刻能提
  ctx.store.setMute(one.id, null)
  assert.match(ctx.store.card({ budget: 2000, scope: 'gui' }).text, /先别问/)
  assert.equal(ctx.store.get(one.id).mute_until, null)
  done(ctx)
})



test('setMute 传 0、负数、NaN、过去的时间，都等于「不挡了」', () => {
  const ctx = fresh()
  const one = ctx.store.remember({ layer: 'semantic', text: '他说周三不太想说话', scope: 'gui' })
  const later = Date.now() + 86_400_000
  assert.equal(ctx.store.setMute(one.id, later).muteUntil, later)
  assert.ok(ctx.store.get(one.id).mute_until > Date.now())

  // 「挡到此刻之前」不成立 —— 传这些值就是在取消，不是「挡一秒」
  for (const value of [0, -1, Number.NaN, Date.now() - 5000]) {
    const done = ctx.store.setMute(one.id, value)
    assert.equal(done.muteUntil, null, `${value} 该算取消`)
    assert.equal(ctx.store.get(one.id).mute_until, null)
  }
  done(ctx)
})

