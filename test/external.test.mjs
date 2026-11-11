import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { closeDatabase, openDatabase } from '../lib/db.js'
import { ExternalIndex, chunkContent, globToRegExp } from '../lib/external.js'

function tempRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), 'seed-ext-'))
  mkdirSync(path.join(dir, '记忆本', '日'), { recursive: true })
  mkdirSync(path.join(dir, '记忆本', '总体'), { recursive: true })
  writeFileSync(
    path.join(dir, '记忆本', '长期.md'),
    '# 长期\n\n- 2026-11-03：有了名字——Carys（卡丽斯），小名阿鱼。\n- 2026-11-04：长了耳朵，能听视频了。\n',
    'utf8',
  )
  writeFileSync(
    path.join(dir, '记忆本', '日', '2026-11-11.md'),
    '# 日\n\n## 触点\n今天她把记忆种进了硬盘。\n\n## 回声\n留下一点安静。\n',
    'utf8',
  )
  writeFileSync(path.join(dir, '记忆本', '总体', '2026-11-11.md'), '# 全文\n\n这一份不该进索引。\n', 'utf8')
  return dir
}

function sourceFor(root) {
  return [
    { id: 'book', label: '记忆本', root: path.join(root, '记忆本'), include: ['长期.md', '日/**'], exclude: ['总体/**'] },
  ]
}

test('globToRegExp 支持 ** 与 *', () => {
  assert.equal(globToRegExp('日/**').test('日/2026-11-11.md'), true)
  assert.equal(globToRegExp('*.md').test('长期.md'), true)
  assert.equal(globToRegExp('总体/**').test('总体/2026-11-11.md'), true)
  assert.equal(globToRegExp('长期.md').test('日/长期.md'), false)
})

test('chunkContent 带起始行号切块', () => {
  const chunks = chunkContent('a\nb\nc\nd', 3)
  assert.ok(chunks.length >= 2)
  assert.equal(chunks[0].line, 1)
  assert.equal(chunks[0].text, 'a\nb')
  assert.equal(chunks[1].line, 3)
})

test('扫描只收 include 且跳过 exclude', () => {
  const root = tempRoot()
  const db = openDatabase(path.join(root, 'seed.db'))
  try {
    const index = new ExternalIndex(db, sourceFor(root))
    const result = index.scan()
    assert.equal(result.files, 2)
    assert.ok(result.chunks >= 2)
    const paths = db.prepare('SELECT path FROM ext_files ORDER BY path').all().map((row) => row.path)
    assert.ok(paths.every((item) => !item.includes('总体')))
    assert.ok(paths.some((item) => item.endsWith('长期.md')))
  } finally {
    closeDatabase(db)
    rmSync(root, { recursive: true, force: true })
  }
})

test('增量扫描：没改就跳过，改了才重建', () => {
  const root = tempRoot()
  const db = openDatabase(path.join(root, 'seed.db'))
  try {
    const index = new ExternalIndex(db, sourceFor(root))
    index.scan()
    const again = index.scan()
    assert.equal(again.files, 0)
    assert.equal(again.skipped, 2)

    const file = path.join(root, '记忆本', '长期.md')
    writeFileSync(file, '# 长期\n\n- 2026-11-12：新加了一条。\n', 'utf8')
    const changed = index.scan()
    assert.equal(changed.files, 1)
    const rows = db.prepare('SELECT text FROM ext_chunks WHERE path = ?').all(file)
    assert.equal(rows.length, 1)
    assert.match(rows[0].text, /2026-11-12/)
  } finally {
    closeDatabase(db)
    rmSync(root, { recursive: true, force: true })
  }
})

test('检索：长词走 FTS，短词走 LIKE', () => {
  const root = tempRoot()
  const db = openDatabase(path.join(root, 'seed.db'))
  try {
    const index = new ExternalIndex(db, sourceFor(root))
    index.scan()

    const long = index.search('记忆种进', { limit: 5 })
    assert.ok(long.length >= 1)
    assert.match(long[0].snippet, /记忆种进/)
    assert.equal(long[0].sourceId, 'book')

    const short = index.search('阿鱼', { limit: 5 })
    assert.ok(short.length >= 1)
  } finally {
    closeDatabase(db)
    rmSync(root, { recursive: true, force: true })
  }
})

test('readAround 只允许读档案根内文件', () => {
  const root = tempRoot()
  const db = openDatabase(path.join(root, 'seed.db'))
  try {
    const index = new ExternalIndex(db, sourceFor(root))
    index.scan()
    const file = path.join(root, '记忆本', '长期.md')
    const around = index.readAround(file, { line: 3, chars: 200 })
    assert.match(around.text, /Carys/)
    assert.throws(() => index.readAround(path.join(root, '..', 'outside.md')), /不在允许的档案根/)
  } finally {
    closeDatabase(db)
    rmSync(root, { recursive: true, force: true })
  }
})

test('stats 报出文件/分块数量', () => {
  const root = tempRoot()
  const db = openDatabase(path.join(root, 'seed.db'))
  try {
    const index = new ExternalIndex(db, sourceFor(root))
    index.scan()
    const stats = index.stats()
    assert.equal(stats.files, 2)
    assert.ok(stats.chunks >= 2)
    assert.equal(stats.sources[0].id, 'book')
  } finally {
    closeDatabase(db)
    rmSync(root, { recursive: true, force: true })
  }
})
