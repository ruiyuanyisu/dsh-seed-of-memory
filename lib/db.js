import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const SCHEMA_VERSION = 12

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  layer         TEXT NOT NULL,
  text          TEXT NOT NULL,
  norm          TEXT NOT NULL,
  fact_key      TEXT,
  source        TEXT NOT NULL,
  confidence    REAL NOT NULL DEFAULT 0.5,
  importance    REAL NOT NULL DEFAULT 0.5,
  emotion       TEXT,
  occurred_at   INTEGER,
  valid_from    INTEGER NOT NULL,
  valid_to      INTEGER,
  recorded_at   INTEGER NOT NULL,
  last_used_at  INTEGER,
  use_count     INTEGER NOT NULL DEFAULT 0,
  superseded_by TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  scope         TEXT NOT NULL DEFAULT 'shared',
  meta          TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_mem_key   ON memories(fact_key, status);
CREATE INDEX IF NOT EXISTS idx_mem_layer ON memories(layer, status);
CREATE INDEX IF NOT EXISTS idx_mem_time  ON memories(recorded_at);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED,
  text,
  tokenize='trigram'
);
`

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS beliefs (
  id            TEXT PRIMARY KEY,
  claim         TEXT NOT NULL,
  norm          TEXT NOT NULL,
  fact_key      TEXT,
  confidence    REAL NOT NULL DEFAULT 0.5,
  sensitivity   REAL NOT NULL DEFAULT 0.5,
  evidence      TEXT NOT NULL DEFAULT '[]',
  source        TEXT NOT NULL DEFAULT 'inferred',
  status        TEXT NOT NULL DEFAULT 'active',
  superseded_by TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_belief_key    ON beliefs(fact_key, status);
CREATE INDEX IF NOT EXISTS idx_belief_status ON beliefs(status, updated_at);

CREATE TABLE IF NOT EXISTS emotions (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  valence     REAL NOT NULL,
  arousal     REAL NOT NULL,
  intensity   REAL NOT NULL,
  cause       TEXT,
  belief_id   TEXT,
  memory_id   TEXT,
  appraisal   TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emotion_time ON emotions(created_at);
CREATE INDEX IF NOT EXISTS idx_emotion_val  ON emotions(valence);

CREATE TABLE IF NOT EXISTS mood (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  valence    REAL NOT NULL,
  arousal    REAL NOT NULL,
  label      TEXT,
  cause      TEXT,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO mood (id, valence, arousal, label, cause, updated_at)
VALUES (1, 0.10, 0.30, '平静', NULL, 0);
`

const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS ext_files (
  path       TEXT PRIMARY KEY,
  root       TEXT NOT NULL,
  mtime      INTEGER NOT NULL,
  size       INTEGER NOT NULL,
  chunks     INTEGER NOT NULL DEFAULT 0,
  scanned_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ext_root ON ext_files(root);

CREATE VIRTUAL TABLE IF NOT EXISTS ext_chunks USING fts5(
  path UNINDEXED,
  line UNINDEXED,
  text,
  tokenize='trigram'
);
`

const SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS traits (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  norm         TEXT NOT NULL,
  statement    TEXT,
  kind         TEXT NOT NULL DEFAULT 'temperament',
  strength     REAL NOT NULL DEFAULT 0.15,
  trend        TEXT NOT NULL DEFAULT 'flat',
  evidence     TEXT NOT NULL DEFAULT '[]',
  counter      TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'candidate',
  meta         TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trait_norm ON traits(norm);
CREATE INDEX IF NOT EXISTS idx_trait_status ON traits(status, strength);

CREATE TABLE IF NOT EXISTS aspiration (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  statement  TEXT NOT NULL,
  keywords   TEXT NOT NULL DEFAULT '[]',
  note       TEXT,
  updated_at INTEGER NOT NULL
);
`

const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS habits (
  id           TEXT PRIMARY KEY,
  key          TEXT NOT NULL,
  name         TEXT NOT NULL,
  norm         TEXT NOT NULL,
  statement    TEXT NOT NULL,
  strength     REAL NOT NULL DEFAULT 0.15,
  evidence     TEXT NOT NULL DEFAULT '[]',
  counter      TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'candidate',
  source       TEXT NOT NULL DEFAULT 'observed',
  meta         TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_habit_norm ON habits(norm);
CREATE INDEX IF NOT EXISTS idx_habit_key ON habits(key, status);
`

const SCHEMA_V6 = `
CREATE TABLE IF NOT EXISTS embeddings (
  ref_type    TEXT NOT NULL,
  ref_id      TEXT NOT NULL,
  model_space TEXT NOT NULL,
  dim         INTEGER NOT NULL,
  vec         BLOB NOT NULL,
  text_hash   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (ref_type, ref_id, model_space)
);
CREATE INDEX IF NOT EXISTS idx_embed_space ON embeddings(model_space);
CREATE INDEX IF NOT EXISTS idx_embed_ref   ON embeddings(ref_type, ref_id);
`

const SCHEMA_V8 = `
CREATE TABLE IF NOT EXISTS consolidation_log (
  id         TEXT PRIMARY KEY,
  memory_id  TEXT NOT NULL,
  action     TEXT NOT NULL,
  score      REAL NOT NULL DEFAULT 0,
  reasons    TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consolidation_memory ON consolidation_log(memory_id, created_at);
`

const SCHEMA_V9 = `
CREATE TABLE IF NOT EXISTS affects (
  id         TEXT PRIMARY KEY,
  target     TEXT NOT NULL DEFAULT '他',
  kind       TEXT NOT NULL,
  strength   REAL NOT NULL DEFAULT 0.3,
  evidence   TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_affect_target ON affects(target, kind);
`

const SCHEMA_V10 = `
CREATE TABLE IF NOT EXISTS qing_state (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

// 熟人卡：一个人一张（群也有自己的一张），字段都短、可以直接改。
// 未完话头：我们问过、还没落定的一句，两天内等他回话。
const SCHEMA_V11 = `
CREATE TABLE IF NOT EXISTS contacts (
  peer       TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  relation   TEXT NOT NULL DEFAULT '',
  birthday   TEXT NOT NULL DEFAULT '',
  likes      TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS loose_ends (
  id         TEXT PRIMARY KEY,
  peer       TEXT NOT NULL,
  session_id TEXT,
  ask        TEXT NOT NULL,
  asked_at   INTEGER NOT NULL,
  due_at     INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',
  closed_at  INTEGER,
  note       TEXT
);
CREATE INDEX IF NOT EXISTS idx_loose_peer ON loose_ends(peer, status);
`

// 心情的小时点：一小时一条，用来在面板上画出「这几天怎么走的」。
// 只存数，不存正文 —— 它不是记忆，是体温计。
const SCHEMA_V12 = `
CREATE TABLE IF NOT EXISTS qing_history (
  at         INTEGER PRIMARY KEY,
  mood       REAL NOT NULL,
  tone       REAL NOT NULL,
  energy     REAL NOT NULL,
  hurt       REAL NOT NULL,
  guilt      REAL NOT NULL,
  pressure   REAL NOT NULL,
  baseline   REAL NOT NULL
);
`

const SCHEMA_V7 = `
CREATE TABLE IF NOT EXISTS captures (
  id         TEXT PRIMARY KEY,
  session_id TEXT,
  text       TEXT NOT NULL,
  norm       TEXT NOT NULL,
  cue        TEXT NOT NULL DEFAULT 'new',
  status     TEXT NOT NULL DEFAULT 'pending',
  memory_id  TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_capture_status ON captures(status, created_at);
CREATE INDEX IF NOT EXISTS idx_capture_norm   ON captures(norm);
`

export function openDatabase(file) {
  const resolved = path.resolve(file)
  mkdirSync(path.dirname(resolved), { recursive: true })
  const db = new DatabaseSync(resolved)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  migrate(db, { file: resolved })
  return db
}

/**
 * 改表之前先留一份：升级出岔子时，用 `.pre-v10` 那个文件就能把库换回来。
 * 只在「老库要往新版本升」时做，新库（version 0）不用。
 */
function backupBeforeUpgrade(db, file, version) {
  if (!file || version <= 0 || version >= SCHEMA_VERSION) return ''
  if (!existsSync(file)) return ''
  const target = `${file}.pre-v${SCHEMA_VERSION}-from-v${version}`
  if (existsSync(target)) return target
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    copyFileSync(file, target)
    return target
  } catch (error) {
    console.warn('[seed-of-memory] 升级前备份失败：' + (error?.message ?? error))
    return ''
  }
}

export function migrate(db, options = {}) {
  const row = db.prepare('PRAGMA user_version').get()
  const version = Number(row.user_version ?? row['user_version'] ?? 0)
  try {
    backupBeforeUpgrade(db, options.file, version)
  } catch (error) {
    console.warn('[seed-of-memory] 升级前备份失败：' + (error?.message ?? error))
  }
  if (version < 1) {
    db.exec(SCHEMA_V1)
  }
  if (version < 2) {
    db.exec(SCHEMA_V2)
  }
  if (version < 3) {
    db.exec(SCHEMA_V3)
  }
  if (version < 4) {
    db.exec(SCHEMA_V4)
  }
  if (version < 5) {
    db.exec(SCHEMA_V5)
  }
  if (version < 6) {
    db.exec(SCHEMA_V6)
  }
  if (version < 7) {
    db.exec(SCHEMA_V7)
  }
  if (version < 8) {
    const columns = new Set(db.prepare('PRAGMA table_info(memories)').all().map((row) => row.name))
    const additions = [
      ['tier', "ALTER TABLE memories ADD COLUMN tier TEXT NOT NULL DEFAULT 'long'"],
      ['strength', 'ALTER TABLE memories ADD COLUMN strength REAL NOT NULL DEFAULT 0.5'],
      ['recalls', 'ALTER TABLE memories ADD COLUMN recalls INTEGER NOT NULL DEFAULT 0'],
      ['session_count', 'ALTER TABLE memories ADD COLUMN session_count INTEGER NOT NULL DEFAULT 1'],
      ['last_recall_at', 'ALTER TABLE memories ADD COLUMN last_recall_at INTEGER'],
      ['expires_at', 'ALTER TABLE memories ADD COLUMN expires_at INTEGER'],
    ]
    for (const [name, ddl] of additions) {
      if (!columns.has(name)) db.exec(ddl)
    }
    db.exec(SCHEMA_V8)
  }
  if (version < 9) {
    const emotionColumns = new Set(
      db.prepare('PRAGMA table_info(emotions)').all().map((row) => row.name)
    )
    if (!emotionColumns.has('object')) {
      db.exec("ALTER TABLE emotions ADD COLUMN object TEXT")
    }
    db.exec(SCHEMA_V9)
  }
  if (version < 10) {
    db.exec(SCHEMA_V10)
  }
  if (version < 11) {
    db.exec(SCHEMA_V11)
  }
  if (version < 12) {
    db.exec(SCHEMA_V12)
  }
  if (version < SCHEMA_VERSION) {

    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }
  return SCHEMA_VERSION
}

export function closeDatabase(db) {
  try {
    db.close()
  } catch {}
}
