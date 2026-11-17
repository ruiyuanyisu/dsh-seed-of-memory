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
    // 造一个「上个版本」的库：按当前 schema 建好，再把 user_version 拨回 9。
    // （以前这里手搓一张只有 (id, text) 的 memories 表，现在迁移是幂等全量跑的，
    //   那种残表连索引都建不上；真实的老库是「旧版本建的整库」，不是缺表。）
    const old = openDatabase(file)
    old
      .prepare(
        "INSERT INTO memories (id, layer, text, norm, source, valid_from, recorded_at) VALUES ('m1', 'semantic', '老数据', '老数据', 'user-said', 0, 0)",
      )
      .run()
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
    const old = openDatabase(file)
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

test('库被人升到 v17 但缺列，再打开也会补齐（版本号不再挡住迁移）', () => {
  const { root, dispose } = tempDir()
  try {
    const file = join(root, 'seed.db')
    openDatabase(file).close()
    // 假装是个打补丁的库：版本号比我们高，但我们加的列它没有
    const raw = new DatabaseSync(file)
    try {
      raw.exec('DROP INDEX IF EXISTS idx_beliefs_scope')
      raw.exec('DROP INDEX IF EXISTS idx_captures_slot')
      raw.exec('ALTER TABLE beliefs DROP COLUMN scope')
      raw.exec('ALTER TABLE captures DROP COLUMN slot')
      raw.exec('PRAGMA user_version = 17')
    } finally {
      raw.close()
    }

    const db = openDatabase(file)
    try {
      const columns = (table) =>
        new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name))
      assert.ok(columns('beliefs').has('scope'), 'beliefs.scope 该补上')
      assert.ok(columns('captures').has('slot'), 'captures.slot 该补上')
      const indexes = new Set(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name),
      )
      assert.ok(indexes.has('idx_beliefs_scope'), '索引也该补上')
      // 版本号只往前推，不往回写 —— 别把别人的分支降级
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 17)
    } finally {
      db.close()
    }
  } finally {
    dispose()
  }
})

test('旧 qing_history（一小时一条）会搬成按人存，老点归到 gui', () => {
  const { root, dispose } = tempDir()
  try {
    const file = join(root, 'seed.db')
    openDatabase(file).close()
    const raw = new DatabaseSync(file)
    try {
      raw.exec('DROP TABLE qing_history')
      raw.exec(`
        CREATE TABLE qing_history (
          at INTEGER PRIMARY KEY, mood REAL NOT NULL, tone REAL NOT NULL, energy REAL NOT NULL,
          hurt REAL NOT NULL, guilt REAL NOT NULL, pressure REAL NOT NULL, baseline REAL NOT NULL
        );
        INSERT INTO qing_history VALUES (3600000, 55, 50, 80, 0, 0, 0, 50);
      `)
      raw.exec('PRAGMA user_version = 12')
    } finally {
      raw.close()
    }

    const db = openDatabase(file)
    try {
      const columns = new Set(
        db.prepare('PRAGMA table_info(qing_history)').all().map((row) => row.name),
      )
      assert.ok(columns.has('slot'), 'qing_history 该有 slot 了')
      const row = db.prepare('SELECT slot, at, mood FROM qing_history').get()
      assert.deepEqual({ ...row }, { slot: 'gui', at: 3600000, mood: 55 })
      // 两个人同一小时各一条，互不覆盖
      db.prepare(
        "INSERT INTO qing_history (slot, at, mood, tone, energy, hurt, guilt, pressure, baseline) VALUES ('qq:10001', 3600000, 40, 40, 70, 5, 0, 5, 50)",
      ).run()
      assert.equal(db.prepare('SELECT count(*) AS n FROM qing_history').get().n, 2)
    } finally {
      db.close()
    }
  } finally {
    dispose()
  }
})

test('老关系账（slot=shared）升级时归到 gui', () => {
  const { root, dispose } = tempDir()
  try {
    const file = join(root, 'seed.db')
    const db = openDatabase(file)
    try {
      db.prepare("INSERT INTO affects (id, target, kind, strength, evidence, slot, updated_at) VALUES ('a1', '他', 'trust', 0.5, '[]', 'shared', 0)").run()
      db.prepare(
        "INSERT INTO affects (id, target, kind, strength, evidence, slot, updated_at) VALUES ('a2', '他', 'warmth', 0.5, '[]', 'qq:10001', 0) ON CONFLICT DO NOTHING",
      ).run()
      db.exec('PRAGMA user_version = 12')
    } finally {
      db.close()
    }
    const again = openDatabase(file)
    try {
      assert.equal(again.prepare("SELECT slot FROM affects WHERE id = 'a1'").get().slot, 'gui')
      assert.equal(again.prepare("SELECT slot FROM affects WHERE id = 'a2'").get().slot, 'qq:10001')
    } finally {
      again.close()
    }
  } finally {
    dispose()
  }
})


test('唯一索引的形状也要对：老库那张 (target, kind) 会被拆了重建成 (slot, target, kind)', () => {
  const { root, dispose } = tempDir()
  try {
    const file = join(root, 'seed.db')
    openDatabase(file).close()
    const raw = new DatabaseSync(file)
    try {
      // 1.4.x 的形状：没有 slot，全表按 (target, kind) 唯一
      raw.exec('DROP INDEX IF EXISTS idx_affect_target')
      raw.exec('DROP INDEX IF EXISTS idx_affects_slot')
      raw.exec('CREATE UNIQUE INDEX idx_affect_target ON affects(target, kind)')
      raw.exec('PRAGMA user_version = 12')
    } finally {
      raw.close()
    }

    const db = openDatabase(file)
    try {
      const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_affect_target'").get().sql)
      assert.match(sql, /\(slot, target, kind\)/, '索引该按三列重建')
      // 第二档现在写得进去（以前会被 (target,kind) 那条静默挡掉）
      const now = Date.now()
      const insert = (slot, kind) =>
        db.prepare('INSERT OR IGNORE INTO affects (id, target, kind, strength, evidence, slot, updated_at) VALUES (?, ?, ?, 0.5, ?, ?, ?)')
          .run(`${slot}-${kind}`, '他', kind, '[]', slot, now)
      insert('gui', '信任')
      insert('qq:10001', '信任')
      const rows = db.prepare("SELECT slot FROM affects WHERE kind = '信任' ORDER BY slot").all()
      assert.deepEqual(rows.map((r) => r.slot), ['gui', 'qq:10001'], '两个人各一份账')
    } finally {
      db.close()
    }
  } finally {
    dispose()
  }
})

test('打过别人补丁的库：槽名是 me 的 qing_history 会归到 gui，曲线不断', () => {
  const { root, dispose } = tempDir()
  try {
    const file = join(root, 'seed.db')
    const db = openDatabase(file)
    try {
      db.prepare("INSERT INTO qing_history (slot, at, mood, tone, energy, hurt, guilt, pressure, baseline) VALUES ('me', 3600000, 60, 55, 70, 0, 0, 0, 50)").run()
      db.exec('PRAGMA user_version = 12')
    } finally {
      db.close()
    }
    const again = openDatabase(file)
    try {
      const rows = again.prepare('SELECT slot, at FROM qing_history').all()
      assert.deepEqual(rows.map((r) => [r.slot, Number(r.at)]), [['gui', 3600000]], '野槽名要归位')
    } finally {
      again.close()
    }
  } finally {
    dispose()
  }
})

test('1.4.x 记下的情绪和待记不会在升级时被摊成共用层', () => {
  const { root, dispose } = tempDir()
  try {
    const file = join(root, 'seed.db')
    openDatabase(file).close()
    const raw = new DatabaseSync(file)
    try {
      // 退回到「没有 slot 列」的老形状，再塞两条记录
      raw.exec('DROP INDEX IF EXISTS idx_emotions_slot')
      raw.exec('DROP INDEX IF EXISTS idx_captures_slot')
      raw.exec('ALTER TABLE emotions DROP COLUMN slot')
      raw.exec('ALTER TABLE captures DROP COLUMN slot')
      raw.exec("INSERT INTO emotions (id, valence, arousal, label, intensity, cause, created_at) VALUES ('e1', -0.5, 0.5, '被骂', 0.6, '群里：傻', 1)")
      raw.exec("INSERT INTO captures (id, session_id, text, norm, cue, status, memory_id, created_at) VALUES ('c1', 'old', '他说周末去山里', '他说周末去山里', 'new', 'pending', NULL, 1)")
      raw.exec('PRAGMA user_version = 12')
    } finally {
      raw.close()
    }

    const db = openDatabase(file)
    try {
      assert.equal(db.prepare("SELECT slot FROM emotions WHERE id = 'e1'").get().slot, 'qq', '老情绪挪进老桶，不再人人可见')
      assert.equal(db.prepare("SELECT slot FROM captures WHERE id = 'c1'").get().slot, 'qq', '老待记同样')
      // 新的还照常写自己的档
      db.prepare("INSERT INTO emotions (id, valence, arousal, label, intensity, cause, slot, created_at) VALUES ('e2', 0.4, 0.5, '被夸', 0.5, '当面：好', 'gui', 2)").run()
      assert.equal(db.prepare("SELECT slot FROM emotions WHERE id = 'e2'").get().slot, 'gui')
    } finally {
      db.close()
    }
  } finally {
    dispose()
  }
})
