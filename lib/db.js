import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const SCHEMA_VERSION = 5

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

export function openDatabase(file) {
  const resolved = path.resolve(file)
  mkdirSync(path.dirname(resolved), { recursive: true })
  const db = new DatabaseSync(resolved)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  migrate(db)
  return db
}

export function migrate(db) {
  const row = db.prepare('PRAGMA user_version').get()
  const version = Number(row.user_version ?? row['user_version'] ?? 0)
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
