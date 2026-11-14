import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { __setWordsFile, wordsSnapshot, refreshWords } from '../lib/qing-words.js'
import { scoreText } from '../lib/qing.js'

const DEFAULT_FILE = fileURLToPath(new URL('../lib/qing-words.json', import.meta.url))

test.afterEach(() => {
  __setWordsFile(DEFAULT_FILE)
})

test('词表是从 json 读进来的，九张表都不空', () => {
  const snap = wordsSnapshot()
  for (const [name, list] of Object.entries(snap)) {
    assert.ok(list.length > 0, `${name} 不该是空的`)
  }
  assert.ok(snap.NEUTRALISE.every((pair) => Array.isArray(pair) && pair.length === 2), 'NEUTRALISE 必须是二维表')
})

test('「失手」算出了事，不算骂人', () => {
  const out = scoreText('失手了，这回没接住')
  assert.equal(out.tone, 'mishap')
  assert.ok(out.mishaps.includes('失手'))
  assert.deepEqual(out.blamed, [])
})

test('改了词表文件，下一次打分就吃到（不用重启）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-words-'))
  const file = join(dir, 'qing-words.json')
  const data = JSON.parse(readFileSync(DEFAULT_FILE, 'utf8'))
  data.PRAISE.push('测试夸词')
  writeFileSync(file, JSON.stringify(data), 'utf8')

  assert.equal(typeof refreshWords(), 'boolean')
  assert.equal(__setWordsFile(file), true)
  const out = scoreText('这招测试夸词')
  assert.equal(out.tone, 'praise')
  assert.ok(out.praised.includes('测试夸词'))

  // 换回默认表之后，这个词就不该再算夸
  __setWordsFile(DEFAULT_FILE)
  assert.equal(scoreText('这招测试夸词').praised.includes('测试夸词'), false)
})

test('文件写坏了就沿用上一份，不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-words-'))
  const file = join(dir, 'qing-words.json')
  writeFileSync(file, '{"PRAISE": [', 'utf8')
  const before = wordsSnapshot().PRAISE.length
  assert.equal(__setWordsFile(file), false)
  assert.equal(wordsSnapshot().PRAISE.length, before)
  assert.equal(scoreText('你好').tone, 'neutral')
})

test('记事本存成带 BOM 的 UTF-8 也认', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-words-'))
  const file = join(dir, 'qing-words.json')
  const data = JSON.parse(readFileSync(DEFAULT_FILE, 'utf8'))
  data.PRAISE.push('BOM夸词')
  writeFileSync(file, '\uFEFF' + JSON.stringify(data), 'utf8')
  assert.equal(__setWordsFile(file), true)
  assert.ok(scoreText('这招 BOM夸词').praised.includes('bom夸词'), '英文部分按小写匹配')
})

test('词表里混进空串、null、数字、重复项都收拾干净，不炸', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-words-'))
  const file = join(dir, 'qing-words.json')
  const data = JSON.parse(readFileSync(DEFAULT_FILE, 'utf8'))
  data.PRAISE = ['好', '', '   ', null, 42, '好', ' 脏夸词 ', ['x']]
  data.NEUTRALISE = [['滚', '回'], ['只有一项'], 'not-a-pair', ['滚', '回']]
  writeFileSync(file, JSON.stringify(data), 'utf8')
  assert.equal(__setWordsFile(file), true)
  const snap = wordsSnapshot()
  assert.deepEqual(snap.PRAISE, ['好', '脏夸词'])
  assert.deepEqual(snap.NEUTRALISE, [['滚', '回']])
  assert.ok(scoreText('这招脏夸词').praised.includes('脏夸词'))
})

test('缺一张表 / 九张全空，都不算改成功，沿用上一份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-words-'))
  const file = join(dir, 'qing-words.json')
  const before = wordsSnapshot()
  const beforePraise = before.PRAISE.length

  const partial = JSON.parse(readFileSync(DEFAULT_FILE, 'utf8'))
  delete partial.BLAME
  writeFileSync(file, JSON.stringify(partial), 'utf8')
  assert.equal(__setWordsFile(file), false)
  assert.equal(wordsSnapshot().BLAME.length, before.BLAME.length, '缺表时不该把别的表清空')

  const empty = Object.fromEntries(Object.keys(before).map((key) => [key, []]))
  writeFileSync(file, JSON.stringify(empty), 'utf8')
  assert.equal(__setWordsFile(file), false)
  assert.equal(wordsSnapshot().PRAISE.length, beforePraise)

  writeFileSync(file, '[1,2,3]', 'utf8')
  assert.equal(__setWordsFile(file), false)
  assert.equal(wordsSnapshot().PRAISE.length, beforePraise)
})

test('同一个坏文件只提醒一次，不刷屏', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-words-'))
  const file = join(dir, 'qing-words.json')
  writeFileSync(file, '{"PRAISE": [', 'utf8')
  const original = console.warn
  const lines = []
  console.warn = (message) => lines.push(String(message))
  try {
    __setWordsFile(file)
    scoreText('晚安，想你了')
    scoreText('今天有点累')
    scoreText('抱抱')
  } finally {
    console.warn = original
  }
  assert.deepEqual(lines.filter((line) => line.includes('词表读取失败')).length, 1)
  assert.equal(scoreText('晚安').tone, 'warm')
})
