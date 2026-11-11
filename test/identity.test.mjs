import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { IdentityFiles } from '../lib/identity.js'

function sandbox() {
  return mkdtempSync(join(tmpdir(), 'seed-identity-'))
}

test('ensure() creates both files with non-empty anchors', () => {
  const dir = sandbox()
  try {
    const files = new IdentityFiles(dir).ensure()
    assert.ok(existsSync(join(dir, 'identity.md')))
    assert.ok(existsSync(join(dir, 'us.md')))
    const text = files.read().text
    assert.match(text, /我是谁/)
    assert.match(text, /我们/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('append() adds a bullet once and is idempotent', () => {
  const dir = sandbox()
  try {
    const files = new IdentityFiles(dir).ensure()
    assert.equal(files.append('us', '她说周末想去山里').added, true)
    assert.equal(files.append('us', '她说周末想去山里').added, false)
    const us = readFileSync(join(dir, 'us.md'), 'utf8')
    assert.equal(us.split('她说周末想去山里').length - 1, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('read() reflects edits made directly to the files', () => {
  const dir = sandbox()
  try {
    const files = new IdentityFiles(dir).ensure()
    files.read()
    files.append('identity', '我用她的声音说话')
    assert.match(files.read().text, /我用她的声音说话/)
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

test('exportTo() copies both anchor files', () => {
  const dir = sandbox()
  try {
    const files = new IdentityFiles(dir).ensure()
    const target = join(dir, 'export-test')
    files.exportTo(target)
    assert.ok(existsSync(join(target, 'identity.md')))
    assert.ok(existsSync(join(target, 'us.md')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeSection keeps heading and replaces body', () => {
  const dir = sandbox()
  try {
    const files = new IdentityFiles(dir).ensure()
    files.writeSection('us', '- 一条新的约定')
    const raw = files.readRaw()
    assert.match(raw.us, /^# 我们/)
    assert.match(raw.us, /一条新的约定/)
    files.writeSection('identity', '# 我是谁\n\n我是阿鱼。')
    assert.match(files.readRaw().identity, /我是阿鱼/)
    assert.throws(() => files.writeSection('us', '   '))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
