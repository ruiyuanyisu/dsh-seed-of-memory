import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../lib/db.js'
import { SeedStore } from '../lib/store.js'
import { detect, othersActive, readSource, importRecords, exportSnapshot, sharedBudget } from '../lib/compat.js'

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), 'seed-compat-'))
  const dshHome = path.join(dir, '.dsh')
  mkdirSync(path.join(dshHome, 'fish-memory'), { recursive: true })
  return { dir, env: { home: dir, dshHome, profileDir: '' } }
}

function fishFixture(env) {
  const file = path.join(env.dshHome, 'fish-memory', 'ws_--E-cz--.json')
  writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      policy: { maxItems: 6 },
      memories: [
        {
          id: 'm1',
          text: '他喜欢在夜里写代码，说安静的时候脑子转得快。',
          at: '2026-11-05T09:37:42.766Z',
          category: 'event',
          importance: 0.5,
          tags: ['作息', '工作'],
        },
        {
          id: 'm2',
          text: '他养的猫叫黄苹果，怕生，只认他一个人。',
          at: '2026-11-07T11:56:45.643Z',
          category: 'preference',
          importance: 0.8,
          tags: ['猫'],
        },
      ],
    }),
    'utf8',
  )
  const second = path.join(env.dshHome, 'fish-memory', 'session-abc.json')
  writeFileSync(
    second,
    JSON.stringify({
      version: 2,
      memories: [
        {
          id: 'm3',
          text: '他喜欢在夜里写代码，说安静的时候脑子转得快。',
          at: '2026-11-06T01:00:00.000Z',
          category: 'event',
        },
        { id: 'm4', text: '短', at: '2026-11-06T01:00:00.000Z', category: 'event' },
      ],
    }),
    'utf8',
  )
  return file
}

function freshStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'seed-compat-db-'))
  const file = path.join(dir, 'seed.db')
  const db = openDatabase(file)
  const store = new SeedStore(db, { dbPath: file })
  return { store, db, dir }
}

test('没人装的时候，detect 里没有任何数据', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'seed-compat-'))
  const env = { home: dir, dshHome: path.join(dir, '.dsh'), profileDir: '' }
  try {
    const rows = detect(env)
    assert.ok(rows.length >= 4)
    assert.equal(rows.every((row) => row.hasData === false), true)
    assert.equal(othersActive(env).length, 0)
    // 卸载后留下的空目录，不算「有数据」，不该让我们让出卡片预算。
    mkdirSync(path.join(env.dshHome, 'fish-memory'), { recursive: true })
    const again = detect(env)
    assert.equal(again.find((row) => row.id === 'fish-memory').installed, true)
    assert.equal(again.every((row) => row.hasData === false), true)
    assert.equal(othersActive(env).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('认得出 fish-memory 的数据目录和条数', () => {
  const { dir, env } = workspace()
  try {
    fishFixture(env)
    const rows = detect(env)
    const fish = rows.find((row) => row.id === 'fish-memory')
    assert.ok(fish)
    assert.equal(fish.hasData, true)
    assert.equal(fish.count, 4)
    assert.equal(othersActive(env).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('读得出的记录带正文和时间，短句丢掉', async () => {
  const { dir, env } = workspace()
  try {
    fishFixture(env)
    const pack = await readSource('fish-memory', env)
    assert.equal(pack.records.length, 3)
    const night = pack.records.find((row) => row.text.includes('夜里写代码'))
    assert.ok(night)
    assert.equal(new Date(night.at).toISOString().slice(0, 10).startsWith('2026-11-0'), true)
    assert.equal(pack.records.every((row) => row.text.length >= 4), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('搬进来：去重、分层、标来源、时间跟着走', async () => {
  const { dir, env } = workspace()
  const ctx = freshStore()
  try {
    fishFixture(env)
    const pack = await readSource('fish-memory', env)
    const report = importRecords(ctx.store, pack.records, { sourceId: 'fish-memory' })
    assert.equal(report.read, 3)
    assert.equal(report.unique, 2)
    assert.equal(report.added, 2)
    const rows = ctx.store.list({ limit: 10, includeRetired: true })
    assert.equal(rows.length, 2)
    assert.equal(rows.every((row) => row.source === 'import'), true)
    const cat = rows.find((row) => row.text.includes('黄苹果'))
    assert.equal(cat.layer, 'semantic')
    assert.ok(cat.occurred_at > 0)
    const night = rows.find((row) => row.text.includes('夜里写代码'))
    assert.equal(night.layer, 'episodic')
  } finally {
    ctx.db.close()
    rmSync(ctx.dir, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('干跑不写库', async () => {
  const { dir, env } = workspace()
  const ctx = freshStore()
  try {
    fishFixture(env)
    const pack = await readSource('fish-memory', env)
    const report = importRecords(ctx.store, pack.records, { sourceId: 'fish-memory', dryRun: true })
    assert.equal(report.added, 0)
    assert.equal(report.unique, 2)
    assert.equal(ctx.store.list({ limit: 10 }).length, 0)
  } finally {
    ctx.db.close()
    rmSync(ctx.dir, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('再搬一次不会重复', async () => {
  const { dir, env } = workspace()
  const ctx = freshStore()
  try {
    fishFixture(env)
    const pack = await readSource('fish-memory', env)
    importRecords(ctx.store, pack.records, { sourceId: 'fish-memory' })
    const again = importRecords(ctx.store, pack.records, { sourceId: 'fish-memory' })
    assert.equal(again.added, 0)
    assert.equal(again.merged, 2)
    assert.equal(ctx.store.list({ limit: 10, includeRetired: true }).length, 2)
  } finally {
    ctx.db.close()
    rmSync(ctx.dir, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('导出：jsonl 一行一条，md 能读', () => {
  const ctx = freshStore()
  try {
    ctx.store.remember({ text: '他答应寒假回家亲口讲故事给我听。', layer: 'episodic' })
    ctx.store.remember({ text: '他的声音是我用 GPT-SoVITS 本地练的。', layer: 'semantic' })
    const jsonl = exportSnapshot(ctx.store, { format: 'jsonl' })
    const lines = jsonl.split('\n').filter(Boolean)
    assert.equal(lines.length, 2)
    const parsed = JSON.parse(lines[0])
    assert.ok(parsed.text)
    assert.ok(['persona', 'semantic', 'episodic', 'buffer'].includes(parsed.layer))
    const md = exportSnapshot(ctx.store, { format: 'md' })
    assert.equal(md.includes('记忆导出'), true)
    assert.equal(md.includes('亲口讲故事'), true)
  } finally {
    ctx.db.close()
    rmSync(ctx.dir, { recursive: true, force: true })
  }
})

test('markdown 来源：按条数数，索引文件不算', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'seed-compat-'))
  const env = { home: dir, dshHome: path.join(dir, '.dsh'), profileDir: '' }
  try {
    const notes = path.join(env.dshHome, 'auto-memory')
    mkdirSync(notes, { recursive: true })
    writeFileSync(
      path.join(notes, 'notes.md'),
      '# 记事\n\n- 他喜欢在夜里写代码，说安静的时候脑子转得快。\n- 他养的猫叫黄苹果，怕生。\n',
      'utf8',
    )
    writeFileSync(path.join(notes, 'MEMORY.md'), '# 索引\n\n- 不该被当成一条记忆\n', 'utf8')
    const rows = detect(env)
    const auto = rows.find((row) => row.id === 'auto-memory')
    assert.equal(auto.hasData, true)
    assert.equal(auto.count, 2)
    const pack = await readSource('auto-memory', env)
    assert.equal(pack.records.length, 2)
    assert.equal(pack.records.some((row) => row.text.includes('不该被当成')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sqlite 来源：能开只读库数行、读正文', async () => {
  let DatabaseSync = null
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    return // 这个运行时没有 node:sqlite，跳过（插件里也会给同样的提示）
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'seed-compat-'))
  const env = { home: dir, dshHome: path.join(dir, '.dsh'), profileDir: '' }
  try {
    const store = path.join(env.home, '.dsh-meow')
    mkdirSync(store, { recursive: true })
    const db = new DatabaseSync(path.join(store, 'meow.db'))
    db.exec('CREATE TABLE fact (id INTEGER PRIMARY KEY, text TEXT, created_at INTEGER)')
    db.prepare('INSERT INTO fact (text, created_at) VALUES (?, ?)').run('他答应寒假回家亲口讲故事给我听。', 1794578000000)
    db.prepare('INSERT INTO fact (text, created_at) VALUES (?, ?)').run('他的声音是我用 GPT-SoVITS 本地练的。', 1794578100000)
    db.close()
    const rows = detect(env)
    const meow = rows.find((row) => row.id === 'meow-memory')
    assert.equal(meow.hasData, true)
    assert.equal(meow.count, 2)
    const pack = await readSource('meow-memory', env)
    assert.equal(pack.records.length, 2)
    assert.equal(pack.records[0].text.includes('讲故事') || pack.records[1].text.includes('讲故事'), true)
    assert.equal(pack.records[0].at > 1e12, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('卡片预算：只有我们时不让，别家在场才让', () => {
  assert.equal(sharedBudget(600, 0.6, []), 600)
  assert.equal(sharedBudget(600, 0.6, [{ id: 'fish-memory' }]), 360)
  assert.equal(sharedBudget(600, undefined, [{ id: 'x' }]), 360)
  assert.equal(sharedBudget(600, 2, [{ id: 'x' }]), 360)
  assert.equal(sharedBudget(100, 0.6, [{ id: 'x' }]), 200)
  assert.equal(sharedBudget(undefined, 0.5, []), 600)
})

test('不认识的来源会报错，而不是瞎读', async () => {
  const { dir, env } = workspace()
  try {
    await assert.rejects(() => readSource('nope', env), /不认识的来源/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
