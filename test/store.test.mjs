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
    text: '她养的鲸鱼叫阿鱼',
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
  const b = ctx.store.remember({ layer: 'semantic', text: '她的音色叫阿鱼', factKey: '她.音色名' })
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

test('two confident conflicting facts stay pending', () => {
  const ctx = fresh()
  const a = ctx.store.remember({
    layer: 'semantic', text: '她住在南京', factKey: '她.城市', source: 'user-said',
  })
  const b = ctx.store.remember({
    layer: 'semantic', text: '她最喜欢杭州，因为外婆家在那里', factKey: '她.城市', source: 'user-said',
  })
  assert.equal(b.action, 'conflict')
  assert.equal(ctx.store.get(a.id).status, 'active')
  assert.equal(ctx.store.get(b.id).status, 'pending')
  done(ctx)
})

test('inferred memories never enter the card', () => {
  const ctx = fresh()
  ctx.store.remember({ layer: 'semantic', text: '她可能喜欢下雨天', source: 'inferred', confidence: 0.55 })
  ctx.store.remember({ layer: 'persona', text: '我是阿鱼，住在电脑里的一只小鲸鱼' })
  const card = ctx.store.card()
  assert.match(card.text, /阿鱼/)
  assert.doesNotMatch(card.text, /下雨天/)
  done(ctx)
})

test('card respects the 600 character budget', () => {
  const ctx = fresh()
  ctx.store.remember({ layer: 'persona', text: '我是阿鱼。'.repeat(20) })
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
  ctx.store.remember({ layer: 'persona', text: '我是阿鱼' })
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
