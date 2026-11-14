import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { SCHEMA_VERSION, migrate, openDatabase } from '../lib/db.js'

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), 'seed-db-'))
  return { root, dispose: () => { try { rmSync(root, { recursive: true, force: true }) } catch {} } }
}

test('老库升级前留一份 .pre-v 备份，新库不留', () => {
  const { root, dispose } = tempDir()
  try {
    const file = join(root, 'seed.db')
    // 造一个「上个版本」的库：只建表、user_version 停在 9
    const old = new DatabaseSync(file)
    old.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT)')
    old.exec("INSERT INTO memories (id, text) VALUES ('m1', '老数据')")
    old.exec('PRAGMA user_version = 9')
    old.close()

    const db = openDatabase(file)
    try {
      const backup = `${file}.pre-v${SCHEMA_VERSION}-from-v9`
      assert.ok(existsSync(backup), '应该留下升级前的备份')
      const copy = new DatabaseSync(backup)
      try {
        assert.equal(copy.prepare('SELECT text FROM memories').get().text, '老数据')
        assert.equal(copy.prepare('PRAGMA user_version').get().user_version, 9)
      } finally {
        copy.close()
      }
      // 升级后的库是新版本、数据还在、新表也建好了
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION)
      assert.equal(db.prepare('SELECT text FROM memories').get().text, '老数据')
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'qing_state'").get().n, 1)
    } finally {
      db.close()
    }

    // 新库（version 0）不该留备份
    const fresh = join(root, 'new.db')
    const db2 = openDatabase(fresh)
    db2.close()
    assert.equal(existsSync(`${fresh}.pre-v${SCHEMA_VERSION}-from-v0`), false)
  } finally {
    dispose()
  }
})

test('同一个老库再开一次不会重复备份', () => {
  const { root, dispose } = tempDir()
  try {
    const file = join(root, 'seed.db')
    const old = new DatabaseSync(file)
    old.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT)')
    old.exec('PRAGMA user_version = 9')
    old.close()

    const db = openDatabase(file)
    db.close()
    const backup = `${file}.pre-v${SCHEMA_VERSION}-from-v9`
    const first = readFileSync(backup).length

    const again = openDatabase(file)
    again.close()
    assert.equal(readFileSync(backup).length, first)
    assert.equal(existsSync(`${backup}.pre-v${SCHEMA_VERSION}-from-v9`), false)
  } finally {
    dispose()
  }
})

test('migrate 可以直接调，不传 file 也不会炸', () => {
  const { root, dispose } = tempDir()
  try {
    const db = new DatabaseSync(join(root, 'plain.db'))
    try {
      assert.equal(migrate(db), SCHEMA_VERSION)
    } finally {
      db.close()
    }
  } finally {
    dispose()
  }
})
