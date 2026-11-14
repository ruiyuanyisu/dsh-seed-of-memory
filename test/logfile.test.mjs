import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { rotateLog, LOG_MAX_BYTES } from '../lib/logfile.js'

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'seed-log-'))
  return {
    dir,
    file: join(dir, 'qq.log'),
    dispose: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    },
  }
}

test('日志还没长到顶就不动它', () => {
  const box = workspace()
  try {
    writeFileSync(box.file, 'hello\n')
    assert.equal(rotateLog(box.file, { maxBytes: 1024 }), 'kept')
    assert.equal(readFileSync(box.file, 'utf8'), 'hello\n')
    assert.equal(existsSync(`${box.file}.1`), false)
  } finally {
    box.dispose()
  }
})

test('太长了就改名留一份，而不是清空', () => {
  const box = workspace()
  try {
    writeFileSync(box.file, 'x'.repeat(LOG_MAX_BYTES + 10))
    assert.equal(rotateLog(box.file), 'rotated')
    assert.equal(existsSync(box.file), false)
    assert.equal(readFileSync(`${box.file}.1`, 'utf8').length, LOG_MAX_BYTES + 10)
  } finally {
    box.dispose()
  }
})

test('轮转后再写就是新文件，旧的那份还在', () => {
  const box = workspace()
  try {
    writeFileSync(box.file, 'old-line\n'.repeat(10))
    assert.equal(rotateLog(box.file, { maxBytes: 5 }), 'rotated')
    writeFileSync(box.file, 'new-line\n')
    assert.equal(readFileSync(`${box.file}.1`, 'utf8').startsWith('old-line'), true)
    assert.equal(readFileSync(box.file, 'utf8'), 'new-line\n')
  } finally {
    box.dispose()
  }
})

test('没有日志文件时什么都不做，也不抛错', () => {
  const box = workspace()
  try {
    assert.equal(rotateLog(box.file), 'kept')
    assert.equal(existsSync(box.file), false)
  } finally {
    box.dispose()
  }
})

test('不要旧文件时可以只清空', () => {
  const box = workspace()
  try {
    writeFileSync(box.file, 'x'.repeat(100))
    assert.equal(rotateLog(box.file, { maxBytes: 10, keep: 0 }), 'reset')
    assert.equal(readFileSync(box.file, 'utf8'), '')
    assert.equal(existsSync(`${box.file}.1`), false)
  } finally {
    box.dispose()
  }
})
