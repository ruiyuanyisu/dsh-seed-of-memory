import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { IdentityFiles } from '../lib/identity.js'

function sandbox() {
  return mkdtempSync(join(tmpdir(), 'seed-identity-'))
}

test('ensure() creates anchors/self/us and reads them back', () => {
  const dir = sandbox()
  try {
    const files = new IdentityFiles(dir).ensure()
    for (const name of ['anchors.md', 'self.md', 'us.md']) {
      assert.ok(existsSync(join(dir, name)), `${name} should exist`)
    }
    const { text, parts } = files.read()
    assert.match(parts.anchors, /善良/)
    assert.match(parts.self, /我是谁/)
    assert.match(parts.us, /我们/)
    assert.match(text, /我叫阿鱼/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('legacy identity.md migrates into self.md once', () => {
  const dir = sandbox()
  try {
    writeFileSync(join(dir, 'identity.md'), '# 我是谁\n\n旧的一页。\n', 'utf8')
    const files = new IdentityFiles(dir).ensure()
    assert.ok(!existsSync(join(dir, 'identity.md')))
    assert.match(files.read().parts.self, /旧的一页/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('append() adds a bullet once and is idempotent', () => {
  const dir = sandbox()
  try {
    const files = new IdentityFiles(dir).ensure()
    assert.equal(files.append('us', '他说周末想去山里').added, true)
    assert.equal(files.append('us', '他说周末想去山里').added, false)
    const us = readFileSync(join(dir, 'us.md'), 'utf8')
    assert.equal(us.split('他说周末想去山里').length - 1, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('append("self") writes the self page, not us', () => {
  const dir = sandbox()
  try {
    const files = new IdentityFiles(dir).ensure()
    files.append('self', '我在学着把话说软。')
    assert.match(files.readRaw().self, /我在学着把话说软/)
    assert.doesNotMatch(files.readRaw().us, /我在学着把话说软/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('read() reflects edits made directly to the files', () => {
  const dir = sandbox()
  try {
    const files = new IdentityFiles(dir).ensure()
    files.read()
    files.append('self', '我用他的声音说话')
    assert.match(files.read().parts.self, /我用他的声音说话/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('append() keeps the trailing note at the bottom', () => {
  const dir = sandbox()
  try {
    const files = new IdentityFiles(dir).ensure()
    files.append('us', '临时约定：每周日一起听歌')
    const us = readFileSync(join(dir, 'us.md'), 'utf8').trimEnd()
    assert.ok(us.endsWith('只写长期不变的事。'))
    const bullets = us.split('\n').filter((line) => line.startsWith('- '))
    assert.equal(bullets.at(-1), '- 临时约定：每周日一起听歌')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('exportTo() copies the three anchor files', () => {
  const dir = sandbox()
  try {
    const files = new IdentityFiles(dir).ensure()
    const target = join(dir, 'export-test')
    files.exportTo(target)
    for (const name of ['anchors.md', 'self.md', 'us.md']) {
      assert.ok(existsSync(join(target, name)), `${name} should be exported`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeSection keeps headings and rejects empty text', () => {  const dir = sandbox()
  try {
    const files = new IdentityFiles(dir).ensure()
    files.writeSection('us', '- 一条新的约定')
    assert.match(files.readRaw().us, /^# 我们/)
    assert.match(files.readRaw().us, /一条新的约定/)
    files.writeSection('self', '# 我是谁\n\n我是阿鱼。')
    assert.match(files.readRaw().self, /我是阿鱼/)
    files.writeSection('anchors', '- 善良。')
    assert.match(files.readRaw().anchors, /善良/)
    assert.throws(() => files.writeSection('us', '   '))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('us.md 被改成目录（或读不了）时，不抛、不把另外两页一起丢掉', () => {
  const dir = sandbox()
  try {
    const files = new IdentityFiles(dir).ensure()
    files.read()
    // 有人手滑把 us.md 变成了目录
    rmSync(join(dir, 'us.md'))
    mkdirSync(join(dir, 'us.md'))
    const read = files.read()
    assert.equal(typeof read.text, 'string')
    assert.match(read.parts.anchors, /善良/)
    assert.match(read.parts.self, /我是谁/)
    assert.equal(read.parts.us, '')
    const appended = files.append('us', '这句话写不进去')
    assert.equal(appended.added, false)
    assert.match(String(appended.error ?? ''), /EISDIR|illegal operation/i)
    const raw = files.readRaw()
    assert.equal(raw.us, '', '面板读坏页时给空文本，不是抛 500')
    assert.match(raw.anchors, /善良/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
