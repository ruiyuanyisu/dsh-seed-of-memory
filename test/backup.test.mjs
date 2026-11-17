import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase } from '../lib/db.js'
import { SeedStore } from '../lib/store.js'
import { backupDaily, backupName, backupStatus, listBackups, pruneBackups, verifyBackup, BACKUP_PREFIX } from '../lib/backup.js'

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'seed-backup-'))
  return {
    dir,
    dispose: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* Windows 上句柄没关干净就删不掉，留在临时目录里无妨 */
      }
    },
  }
}

function makeDb(dir, name = 'seed.db') {
  const file = join(dir, name)
  const db = openDatabase(file)
  new SeedStore(db).remember({ text: '备份也要记得这条', layer: 'episodic', source: 'user-said', importance: 0.6 })
  return { db, file }
}

function closeQuietly(db) {
  try {
    db?.close?.()
  } catch {
    /* ignore */
  }
}

test('备份文件名按天分，同一天只有一个', () => {
  const day = Date.UTC(2026, 10, 14, 3, 0, 0)
  assert.equal(backupName(day), `${BACKUP_PREFIX}2026-11-14`)
  assert.equal(backupName(day + 1000), backupName(day))
})

test('一天只做一份，第二回直接跳过', () => {
  const box = workspace()
  const { db, file } = makeDb(box.dir)
  try {
    const first = backupDaily(db, file, box.dir, { keep: 3, now: Date.UTC(2026, 10, 14) })
    assert.ok(first && existsSync(first))
    const second = backupDaily(db, file, box.dir, { keep: 3, now: Date.UTC(2026, 10, 14, 12) })
    assert.equal(second, null)
    assert.equal(readdirSync(box.dir).filter((n) => n.startsWith(BACKUP_PREFIX)).length, 1)
  } finally {
    closeQuietly(db)
    box.dispose()
  }
})

test('备份是一份能打开的完整库，内容都在', () => {
  const box = workspace()
  const { db, file } = makeDb(box.dir)
  try {
    const target = backupDaily(db, file, box.dir, { keep: 3, now: Date.UTC(2026, 10, 14) })
    const copy = openDatabase(target)
    try {
      const row = copy.prepare("SELECT text FROM memories WHERE text = '备份也要记得这条'").get()
      assert.equal(row?.text, '备份也要记得这条')
    } finally {
      closeQuietly(copy)
    }
  } finally {
    closeQuietly(db)
    box.dispose()
  }
})

test('只留最近几份，旧的删掉', () => {
  const box = workspace()
  try {
    for (const day of ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']) {
      writeFileSync(join(box.dir, `${BACKUP_PREFIX}${day}`), 'x')
    }
    const removed = pruneBackups(box.dir, 2)
    assert.deepEqual(removed, [`${BACKUP_PREFIX}2026-11-10`, `${BACKUP_PREFIX}2026-11-11`])
    assert.deepEqual(listBackups(box.dir), [`${BACKUP_PREFIX}2026-11-12`, `${BACKUP_PREFIX}2026-11-13`])
  } finally {
    box.dispose()
  }
})

test('库里还没有文件时不报错，就当没备份', () => {
  const box = workspace()
  try {
    assert.equal(backupDaily(null, join(box.dir, 'nope.db'), box.dir), null)
    assert.equal(backupDaily({ exec() {} }, join(box.dir, 'nope.db'), box.dir), null)
    assert.deepEqual(backupStatus(box.dir), { count: 0, bytes: 0, latest: null })
  } finally {
    box.dispose()
  }
})

test('备份状态说得出几份、多大', () => {
  const box = workspace()
  try {
    writeFileSync(join(box.dir, `${BACKUP_PREFIX}2026-11-13`), 'abc')
    writeFileSync(join(box.dir, `${BACKUP_PREFIX}2026-11-14`), 'abcd')
    writeFileSync(join(box.dir, 'seed.db'), 'not-a-backup')
    const status = backupStatus(box.dir)
    assert.equal(status.count, 2)
    assert.equal(status.bytes, 7)
    assert.equal(status.latest, `${BACKUP_PREFIX}2026-11-14`)
  } finally {
    box.dispose()
  }
})

test('清理只删真备份，同名目录和怪文件不碰，也不谎报删了', () => {
  const box = workspace()
  try {
    for (const day of ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']) {
      writeFileSync(join(box.dir, `${BACKUP_PREFIX}${day}`), 'x')
    }
    mkdirSync(join(box.dir, `${BACKUP_PREFIX}2020-01-01`), { recursive: true })
    writeFileSync(join(box.dir, `${BACKUP_PREFIX}2020-01-02.txt`), 'not a real backup')
    writeFileSync(join(box.dir, `${BACKUP_PREFIX}old`), 'not a real backup either')

    const removed = pruneBackups(box.dir, 2)
    assert.deepEqual(removed, [`${BACKUP_PREFIX}2026-11-10`, `${BACKUP_PREFIX}2026-11-11`, `${BACKUP_PREFIX}2026-11-12`])
    const left = readdirSync(box.dir).sort()
    assert.deepEqual(left, [
      `${BACKUP_PREFIX}2020-01-01`,
      `${BACKUP_PREFIX}2020-01-02.txt`,
      `${BACKUP_PREFIX}2026-11-13`,
      `${BACKUP_PREFIX}2026-11-14`,
      `${BACKUP_PREFIX}old`,
    ])
  } finally {
    box.dispose()
  }
})


test('0 字节的文件不算备份成功：integrity_check 会说它是个合法的空库', () => {
  const ws = workspace()
  const empty = join(ws.dir, 'empty.db')
  writeFileSync(empty, Buffer.alloc(0))
  assert.equal(verifyBackup(empty), false)
  assert.equal(verifyBackup(join(ws.dir, '没有这个文件.db')), false)

  const { db, file } = makeDb(ws.dir, 'real.db')
  assert.equal(verifyBackup(file), true, '有内容的库该认')
  closeQuietly(db)
  ws.dispose()
})
