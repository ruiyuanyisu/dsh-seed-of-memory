import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openDatabase, closeDatabase } from '../lib/db.js'
import { SeedStore } from '../lib/store.js'
import { SemanticIndex, blobToVec, cosine, textHash, vecToBlob } from '../lib/semantic.js'

const VECTORS = {
  她怕冷: [1, 0, 0, 0],
  冬天手脚冰凉: [0.95, 0.05, 0, 0],
  今天发布了记忆插件: [0, 1, 0, 0],
  怕冷: [1, 0, 0, 0],
}

function fakeEmbedder() {
  return {
    calls: 0,
    async embed(texts) {
      this.calls += 1
      const vectors = texts.map((text) => VECTORS[String(text)] ?? [0, 0, 1, 0])
      return { ok: true, vectors, model: 'fake', dimension: 4 }
    },
  }
}

function failingEmbedder() {
  return {
    async embed() {
      return { ok: false, error: 'connection refused' }
    },
  }
}

async function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'som-semantic-'))
  const db = openDatabase(join(dir, 'seed.db'))
  const store = new SeedStore(db)
  try {
    return await fn({ db, store, dir })
  } finally {
    closeDatabase(db)
    rmSync(dir, { recursive: true, force: true })
  }
}

test('向量与余弦：往返、相同、正交', () => {
  const blob = vecToBlob([0.5, -0.25, 1])
  const back = blobToVec(blob)
  assert.equal(back.length, 3)
  assert.ok(Math.abs(back[1] + 0.25) < 1e-6)
  assert.ok(Math.abs(cosine(new Float32Array([1, 0]), new Float32Array([1, 0])) - 1) < 1e-9)
  assert.ok(Math.abs(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))) < 1e-9)
  assert.equal(cosine(new Float32Array([0, 0]), new Float32Array([1, 1])), 0)
})

test('textHash 稳定且区分内容', () => {
  assert.equal(textHash('她怕冷'), textHash('她怕冷'))
  assert.notEqual(textHash('她怕冷'), textHash('她怕冷吗'))
  assert.equal(textHash('她怕冷').length, 16)
})

test('索引统计与回填是幂等的', async () => {
  await withDb(async ({ db, store }) => {
    const a = store.remember({ text: '她怕冷', layer: 'semantic' })
    const b = store.remember({ text: '冬天手脚冰凉', layer: 'episodic' })
    store.remember({ text: '今天发布了记忆插件', layer: 'episodic' })
    const index = new SemanticIndex(db, fakeEmbedder(), { space: 'fake@4-v1', dimension: 4 })

    let stats = index.stats()
    assert.equal(stats.total, 3)
    assert.equal(stats.indexed, 0)
    assert.equal(stats.pending, 3)
    assert.equal(stats.coverage, 0)

    const first = await index.backfill({ batch: 8 })
    assert.equal(first.embedded, 3)
    assert.equal(first.remaining, 0)

    stats = index.stats()
    assert.equal(stats.indexed, 3)
    assert.equal(stats.coverage, 1)

    const again = await index.backfill({ batch: 8 })
    assert.equal(again.embedded, 0)
    assert.ok(a.id && b.id)
  })
})

test('queryScores 只返回相似度达标的条目', async () => {
  await withDb(async ({ db, store }) => {
    store.remember({ text: '她怕冷', layer: 'semantic' })
    const winter = store.remember({ text: '冬天手脚冰凉', layer: 'episodic' })
    store.remember({ text: '今天发布了记忆插件', layer: 'episodic' })
    const index = new SemanticIndex(db, fakeEmbedder(), { space: 'fake@4-v1', dimension: 4 })
    await index.backfill({ batch: 8 })

    const scores = await index.queryScores('怕冷')
    assert.ok(scores instanceof Map)
    assert.ok(scores.get(winter.id) > 0.9)
    assert.equal(scores.size, 2) // 怕冷 + 冬天手脚冰凉；发布插件那条余弦为 0 被过滤
  })
})

test('运行时不可用时回填与检索都安静降级', async () => {
  await withDb(async ({ db, store }) => {
    store.remember({ text: '她怕冷', layer: 'semantic' })
    const index = new SemanticIndex(db, failingEmbedder(), { space: 'fake@4-v1' })
    const result = await index.backfill({ batch: 4 })
    assert.equal(result.embedded, 0)
    assert.match(result.error, /connection refused/)
    assert.equal(index.stats().indexed, 0)
    assert.equal(await index.queryScores('怕冷'), null)
    assert.equal(index.clear().removed, 0)
  })
})

test('检索：语义候选只补「很像」的，并排到前面', async () => {
  await withDb(async ({ db, store }) => {
    const cold = store.remember({ text: '她怕冷', layer: 'semantic' })
    const winter = store.remember({ text: '冬天手脚冰凉', layer: 'episodic' })

    // 「冬天冷」在 FTS 里两个都不命中（trigram 找不到连续子串）
    const plain = store.search('冬天冷', { limit: 5 })
    assert.equal(plain.length, 0)

    // 0.42 低于补候选地板 0.55，不进来；0.93 进来并排第一
    const scores = new Map([
      [cold.id, 0.42],
      [winter.id, 0.93],
    ])
    const blended = store.search('冬天冷', { limit: 5, semantic: { scores, weight: 0.55 } })
    assert.equal(blended.length, 1)
    assert.equal(blended[0].id, winter.id)
    assert.equal(blended[0].cosine, 0.93)
    assert.ok(blended[0].score > 0.5)
  })
})

test('清空后重扫：pending 回到总数，reindex 补齐', async () => {
  await withDb(async ({ db, store }) => {
    store.remember({ text: '她怕冷', layer: 'semantic' })
    store.remember({ text: '冬天手脚冰凉', layer: 'episodic' })
    const index = new SemanticIndex(db, fakeEmbedder(), { space: 'fake@4-v1' })
    await index.backfill({ batch: 8 })
    assert.equal(index.stats().pending, 0)

    const cleared = index.clear()
    assert.equal(cleared.removed, 2)
    assert.equal(index.stats().pending, 2)

    const rebuilt = await index.reindex({ batch: 8 })
    assert.equal(rebuilt.ok, true)
    assert.equal(rebuilt.embedded, 2)
    assert.equal(rebuilt.stats.pending, 0)
  })
})

test('reindex 会一直补到没有待办，不是只补一批', async () => {
  await withDb(async ({ db, store }) => {
    for (let i = 0; i < 20; i += 1) store.remember({ text: `第 ${i} 条`, layer: 'episodic' })
    const index = new SemanticIndex(db, fakeEmbedder(), { space: 'fake@4-v1' })

    const rebuilt = await index.reindex({ batch: 8 })
    assert.equal(rebuilt.ok, true)
    // 老实现只补 8 条就返回了，按钮上写着「重建索引」，实际留下 12 条空的。
    assert.equal(rebuilt.embedded, 20, '20 条全补进来，不是只补一批')
    assert.equal(rebuilt.remaining, 0)
    assert.ok(rebuilt.rounds >= 3, `至少要转三轮，实际 ${rebuilt.rounds} 轮`)
    assert.equal(rebuilt.stats.pending, 0)
  })
})

test('reindex 有刹车：轮数用光就先返回，remaining 如实报', async () => {
  await withDb(async ({ db, store }) => {
    for (let i = 0; i < 20; i += 1) store.remember({ text: `第 ${i} 条`, layer: 'episodic' })
    const index = new SemanticIndex(db, fakeEmbedder(), { space: 'fake@4-v1' })

    const partial = await index.reindex({ batch: 8, maxRounds: 1 })
    assert.equal(partial.ok, true)
    assert.equal(partial.embedded, 8)
    assert.equal(partial.remaining, 12, '剩下的要如实报出来，别让人以为全好了')
    assert.equal(partial.rounds, 1)
  })
})

test('queryScores 只在给的那一档里挑：别的档看得见也不该拿来算', async () => {
  await withDb(async ({ db, store }) => {
    const mine = store.remember({ text: '她怕冷', layer: 'semantic', scope: 'qq:10001' })
    const other = store.remember({ text: '冬天手脚冰凉', layer: 'episodic', scope: 'qq:20002' })
    const index = new SemanticIndex(db, fakeEmbedder(), { space: 'fake@4-v1', dimension: 4 })
    await index.backfill({ batch: 8 })

    const all = await index.queryScores('怕冷')
    assert.ok(all.size >= 2, '不限定的时候还是全库挑')

    const onlyMine = await index.queryScores('怕冷', { ids: [mine.id] })
    assert.ok(onlyMine.has(mine.id))
    assert.ok(!onlyMine.has(other.id), '别人那一档的向量不该算进来')

    const none = await index.queryScores('怕冷', { ids: [] })
    assert.equal(none, null, '一条都看不见就别白算了')
  })
})
