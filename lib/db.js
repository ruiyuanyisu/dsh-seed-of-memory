import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { canonScope } from './scope.js'

export const SCHEMA_VERSION = 15

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
  scope         TEXT NOT NULL DEFAULT 'shared',
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
  slot        TEXT NOT NULL DEFAULT 'shared',
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
  slot       TEXT NOT NULL DEFAULT 'gui',
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_affect_target ON affects(slot, target, kind);
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

// 按人隔离：一句「你好」是谁说的，得能分开记。
// 取值见 lib/scope.js：shared（共用）/ gui（当面）/ qq:<QQ号> / group:<群号>，
// 老的 qq 桶只留着读。mood / qing_state 是我自己一个人的体温，不分人；
// qing_history 按 slot 分条，是因为两个人同一小时说话不该互相盖掉。
const SCHEMA_V13 = `
CREATE INDEX IF NOT EXISTS idx_beliefs_scope  ON beliefs(scope, status);
CREATE INDEX IF NOT EXISTS idx_captures_slot  ON captures(slot, status, created_at);
CREATE INDEX IF NOT EXISTS idx_emotions_slot  ON emotions(slot, created_at);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, layer, status, importance DESC, recorded_at DESC);
`

/**
 * 加一列，已经有就跳过。
 * ALTER TABLE ... ADD COLUMN 重复执行会直接报错，所以要先问 PRAGMA；
 * 表本身不在（老库只建了一部分表）也跳过 —— 建表是前面那些 SCHEMA 的事。
 * 返回「这次真的加上了」：调用方要靠它判断「表里的默认值是我刚填的，还是本来就有」。
 */
function addColumnIfMissing(db, table, name, ddl) {
  const exists = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  if (!Number(exists?.n)) return false
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name))
  if (columns.has(name)) return false
  db.exec(ddl)
  return true
}

/**
 * 唯一索引不能只靠 `IF NOT EXISTS`：它只认名字，不认形状。
 *
 * 1.4.x 那张 `idx_affect_target` 是 `UNIQUE(target, kind)`，1.5.0 想建成
 * `UNIQUE(slot, target, kind)` —— 名字一样，于是新的一条永远建不出来，老索引留着。
 * 后果不是「改错人」，是「谁都没改到」：只有第一个档占得住那四格，别人的
 * ensureAffects 全被 INSERT OR IGNORE 静默丢掉，各人一份账整块失效
 * （REVIEW-150 第五轮实测：非 gui 档 affects 全空）。
 *
 * 所以索引一律按列比对，定义变了就拆了重建。
 */
function ensureIndexShape(db, name, table, columns, { unique = false } = {}) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name)
  const want = `(${columns.join(', ')})`.toLowerCase()
  const sql = String(row?.sql ?? '').toLowerCase().replace(/\s+/g, ' ')
  const sameShape = Boolean(row) && sql.includes(want) && (!unique || sql.includes('unique index'))
  if (row && !sameShape) db.exec(`DROP INDEX IF EXISTS ${name}`)
  db.exec(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${name} ON ${table}(${columns.join(', ')})`)
  return Boolean(row) && !sameShape
}

/** 索引的「应该长什么样」。每次打开都按这个比对一遍，名字对、列不对就重建。 */
const INDEX_SHAPES = [
  ['idx_affect_target', 'affects', ['slot', 'target', 'kind'], true],
  // 这里原本还有一条 idx_affects_slot ['slot','target','kind']（普通索引）——
  // 和上面那条唯一的列完全一样，唯一索引能覆盖普通索引的所有查找，
  // 多建一棵树只是在每次写 affects 时白维护一遍（REVIEW-151 第十七轮 ⑨）。
  ['idx_beliefs_scope', 'beliefs', ['scope', 'status'], false],
  ['idx_captures_slot', 'captures', ['slot', 'status', 'created_at'], false],
  ['idx_emotions_slot', 'emotions', ['slot', 'created_at'], false],
  ['idx_memories_scope', 'memories', ['scope', 'layer', 'status', 'importance DESC', 'recorded_at DESC'], false],
]

/** qing 的槽名收拾：'me' / 'local' / 空 这些都是「我」，归 gui。 */
function qingSlotName(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return 'gui'
  if (['me', 'local', 'panel', 'self', 'default', 'gui'].includes(value.toLowerCase())) return 'gui'
  return canonScope(value)
}

/**
 * 野槽名归位。别的补丁把 slot 写成 'me' 之后，`history(slot='gui')` 一条都读不到：
 * 曲线断得无声，streak 也数不出连着几小时（REVIEW-150 第二轮实测）。
 * 只在前缀能认出来时改，认不出的原样留着 —— 宁可留着，也别猜错。
 */
function normalizeSlotTable(db, table, column) {
  const exists = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  if (!Number(exists?.n)) return { fixed: 0, lost: 0 }
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name))
  if (!columns.has(column)) return { fixed: 0, lost: 0 }
  const values = db.prepare(`SELECT DISTINCT ${column} AS v FROM ${table}`).all()
  let fixed = 0
  // UPDATE OR REPLACE 撞主键时会删掉冲突行 —— 那是设计，但「丢了几行」得说出来，
  // 不然一次归位悄悄吃掉半条曲线，谁也不知道（REVIEW-152 第十一轮）。
  let lost = 0
  const failed = []
  for (const row of values) {
    const raw = row.v
    if (raw == null) continue
    const want = table === 'qing_history' ? qingSlotName(raw) : canonScope(raw)
    if (String(want) === String(raw)) continue
    try {
      // OR REPLACE 是必须的：qing_history 主键是 (slot, at)，
      // 把 'me' 那几行改成 'gui' 时，同一小时可能已经有一行 'gui' ——
      // 裸 UPDATE 会撞主键、被 catch 吞掉，那几行就永远留在野槽名上（REVIEW-151 第二轮）。
      // OR REPLACE 撞了就删掉冲突行、以这次要写进去的为准；别的表 slot 不是主键，没有副作用。
      const countRows = () => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0)
      const before = countRows()
      db.prepare(`UPDATE OR REPLACE ${table} SET ${column} = ? WHERE ${column} = ?`).run(want, raw)
      const after = countRows()
      if (after < before) lost += before - after
      fixed += 1
    } catch (error) {
      // 改不动就别装作改过了：把槽名和原因记下来，调用方可以报出去。
      failed.push({ table, from: String(raw), to: String(want), error: String(error?.message ?? error) })
    }
  }
  if (failed.length) {
    // 尽量不中断迁移，但一定要留痕：console 里能看见，比默默不动强。
    try {
      console.warn('[seed-of-memory] 槽名归位失败：' + failed.map((f) => `${f.table} ${f.from}->${f.to}`).join('；'))
    } catch {
      /* ignore */
    }
  }
  return { fixed, lost }
}

/**
 * qing_history 原来主键只有 at —— 两个人同一小时说话，后一个把前一个盖掉，
 * 「连着骂了两句」也会跨人算错。改成 (slot, at)：一个人的曲线只留自己的点。
 * 这是张小表（最多几百行），直接重建最干净。
 *
 * 判断依据不能只是「表里有没有 slot 列」：有列但槽名是野的（打过别人补丁的库
 * 就是 'me'），一样要收拾 —— 见 normalizeSlotTable。
 */
function rebuildQingHistory(db) {
  const exists = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'qing_history'").get()
  if (!Number(exists?.n)) return false
  const columns = new Set(db.prepare('PRAGMA table_info(qing_history)').all().map((row) => row.name))
  if (columns.has('slot')) {
    const done = normalizeSlotTable(db, 'qing_history', 'slot')
    if (Number(done?.lost ?? 0) > 0) {
      // 同一个小时里 'me' 和 'gui' 各有一个点：归位必然撞主键，只能留一个。
      // 留哪个是运气，但「丢了一条曲线点」这件事必须有人看得见（REVIEW-152 第十一轮）。
      try {
        console.warn(`[seed-of-memory] 槽名归位：qing_history 撞车丢 ${done.lost} 行`)
      } catch {
        /* ignore */
      }
    }
    return Number(done?.fixed ?? 0) > 0
  }
  db.exec(`
    ALTER TABLE qing_history RENAME TO qing_history_v12;
    CREATE TABLE qing_history (
      slot       TEXT NOT NULL DEFAULT 'gui',
      at         INTEGER NOT NULL,
      mood       REAL NOT NULL,
      tone       REAL NOT NULL,
      energy     REAL NOT NULL,
      hurt       REAL NOT NULL,
      guilt      REAL NOT NULL,
      pressure   REAL NOT NULL,
      baseline   REAL NOT NULL,
      PRIMARY KEY (slot, at)
    );
    INSERT OR REPLACE INTO qing_history (slot, at, mood, tone, energy, hurt, guilt, pressure, baseline)
      SELECT 'gui', at, mood, tone, energy, hurt, guilt, pressure, baseline FROM qing_history_v12;
    DROP TABLE qing_history_v12;
    CREATE INDEX IF NOT EXISTS idx_qing_history_at ON qing_history(at);
  `)
  return true
}


const SCHEMA_V7 = `
CREATE TABLE IF NOT EXISTS captures (
  id         TEXT PRIMARY KEY,
  session_id TEXT,
  text       TEXT NOT NULL,
  norm       TEXT NOT NULL,
  cue        TEXT NOT NULL DEFAULT 'new',
  status     TEXT NOT NULL DEFAULT 'pending',
  memory_id  TEXT,
  slot       TEXT NOT NULL DEFAULT 'shared',
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
  // 写锁冲突时要等，不能零毫秒就失败（REVIEW-152 第十七轮实测 timeout=0）。
  // 同一台机器上写者不止一个：插件、面板、/seed 命令、每日备份、外部脚本。
  // 而插件的写路径大多在 try/catch 里，冲突时那句话会悄悄没记上——
  // 这套东西的全部价值就是「都记得住」，五秒等不到锁才该报错。
  db.exec('PRAGMA busy_timeout = 5000')
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

/**
 * 建表建索引这一批全是 IF NOT EXISTS，所以每次打开都跑一遍，不再看版本号。
 * 这就是「版本号撞车」的解药：别人的补丁把 user_version 推到 17，我们缺的列、
 * 缺的索引照样补得上，不会因为「版本比我们高」就整段跳过（跳过 = 静默坏掉）。
 */
const SCHEMAS = [
  SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5, SCHEMA_V6, SCHEMA_V7,
  SCHEMA_V8, SCHEMA_V9, SCHEMA_V10, SCHEMA_V11, SCHEMA_V12, SCHEMA_V13,
]

/** 加列不能重复执行，所以列成表，由 addColumnIfMissing 挨个问 PRAGMA。 */
const ADDED_COLUMNS = [
  ['memories', 'tier', "ALTER TABLE memories ADD COLUMN tier TEXT NOT NULL DEFAULT 'long'"],
  ['memories', 'strength', 'ALTER TABLE memories ADD COLUMN strength REAL NOT NULL DEFAULT 0.5'],
  ['memories', 'recalls', 'ALTER TABLE memories ADD COLUMN recalls INTEGER NOT NULL DEFAULT 0'],
  ['memories', 'session_count', 'ALTER TABLE memories ADD COLUMN session_count INTEGER NOT NULL DEFAULT 1'],
  ['memories', 'last_recall_at', 'ALTER TABLE memories ADD COLUMN last_recall_at INTEGER'],
  ['memories', 'expires_at', 'ALTER TABLE memories ADD COLUMN expires_at INTEGER'],
  // 「暂时别说」：有空值 = 照常提；有值 = 到那个时刻之前不摆到台面上（REVIEW-153 第十轮扩展 ⑥）
  ['memories', 'mute_until', 'ALTER TABLE memories ADD COLUMN mute_until INTEGER'],
  ['emotions', 'object', 'ALTER TABLE emotions ADD COLUMN object TEXT'],
  ['beliefs', 'scope', "ALTER TABLE beliefs ADD COLUMN scope TEXT NOT NULL DEFAULT 'shared'"],
  ['captures', 'slot', "ALTER TABLE captures ADD COLUMN slot TEXT NOT NULL DEFAULT 'shared'"],
  ['emotions', 'slot', "ALTER TABLE emotions ADD COLUMN slot TEXT NOT NULL DEFAULT 'shared'"],
  ['affects', 'slot', "ALTER TABLE affects ADD COLUMN slot TEXT NOT NULL DEFAULT 'gui'"],
]

export function migrate(db, options = {}) {
  const row = db.prepare('PRAGMA user_version').get()
  const version = Number(row.user_version ?? row['user_version'] ?? 0)
  try {
    backupBeforeUpgrade(db, options.file, version)
  } catch (error) {
    console.warn('[seed-of-memory] 升级前备份失败：' + (error?.message ?? error))
  }
  // 整个升级包在一个 SAVEPOINT 里：半路炸了就原样退回去，不留「表建了一半、
  // 字段加了一半」的库。（裸 BEGIN 在嵌套事务里会抛，所以这里用 SAVEPOINT）
  db.exec('SAVEPOINT seed_migrate')
  try {
    // 第一轮：建表能过，但「表在、列不在」（别人的补丁把版本号推高、列却没加）
    // 时，同一块里跟着建索引的语句会报 no such column —— 这一轮先容错，补完列再来一遍。
    for (const sql of SCHEMAS) {
      try {
        db.exec(sql)
      } catch {
        /* 第二轮会重来，这里失败不算数 */
      }
    }
    const added = new Set()
    for (const [table, name, ddl] of ADDED_COLUMNS) {
      if (addColumnIfMissing(db, table, name, ddl)) added.add(`${table}.${name}`)
    }
    rebuildQingHistory(db)
    // 第二轮不再容错：真缺东西就炸在明面上，别带着半张表继续跑。
    for (const sql of SCHEMAS) db.exec(sql)
    // 索引按形状比对：名字对、列不对（1.4.x 的 affects 唯一索引就是这样）就重建
    for (const [name, table, columns, unique] of INDEX_SHAPES) {
      ensureIndexShape(db, name, table, columns, { unique: Boolean(unique) })
    }
    // 1.4.x 的一个补丁建过单数名字的同一棵树（idx_belief_scope），和复数那条重复
    db.exec('DROP INDEX IF EXISTS idx_belief_scope')
    // 同上：idx_affects_slot 和唯一索引 idx_affect_target 的列一模一样，白养一棵树
    db.exec('DROP INDEX IF EXISTS idx_affects_slot')
    // 两条僵尸索引：建在 1.4.x 的废弃列上（emotions.scope 从 1.5 起一直是 NULL，
    // captures.session_id 没人查）。列留在表里当化石（回退 1.4.x 还接得上），
    // 但索引不该跟着留着 —— 每次插入都要维护一棵永远没人走的树（REVIEW-152 第十二轮）。
    db.exec('DROP INDEX IF EXISTS idx_emotion_scope')
    db.exec('DROP INDEX IF EXISTS idx_capture_session')
    // 1.4.x 的关系账只有一个「他」，那就是老大本人：搬到 gui 档，
    // 别留成 slot='shared' 让谁读了都当成自己的。我们自己的代码从不写 shared。
    db.exec("UPDATE affects SET slot = 'gui' WHERE slot = 'shared'")
    // 1.4.x 的 emotions / captures 没有档位概念，加列时 ALTER 会给所有老行填默认值
    // 'shared' —— 那等于把当时私聊里记下的东西摊给所有人看。刚加列时挪进老桶 qq：
    // 谁的会话都不再自动读到（老桶现在只有当面/面板看得见），但一条没删。
    if (added.has('emotions.slot')) db.exec("UPDATE emotions SET slot = 'qq' WHERE slot = 'shared'")
    if (added.has('captures.slot')) db.exec("UPDATE captures SET slot = 'qq' WHERE slot = 'shared'")
    // 野槽名归位（'me' → 'gui' 这类别人补丁留下的写法）
    let movedSlots = 0
    let lostRows = 0
    for (const [table, column] of [
      ['emotions', 'slot'],
      ['captures', 'slot'],
      ['affects', 'slot'],
      ['memories', 'scope'],
      ['beliefs', 'scope'],
    ]) {
      const done = normalizeSlotTable(db, table, column)
      movedSlots += Number(done?.fixed ?? 0)
      lostRows += Number(done?.lost ?? 0)
    }
    if (lostRows) {
      // 不中断迁移，但一定留痕：撞车被 OR REPLACE 吃掉的行数。
      try {
        console.warn(`[seed-of-memory] 槽名归位：搬 ${movedSlots} 个槽名，撞车丢 ${lostRows} 行`)
      } catch {
        /* ignore */
      }
    }
    const next = Math.max(version, SCHEMA_VERSION)
    db.exec(`PRAGMA user_version = ${next}`)
    db.exec('RELEASE seed_migrate')
    return next
  } catch (error) {
    try {
      db.exec('ROLLBACK TO seed_migrate')
      db.exec('RELEASE seed_migrate')
    } catch {
      /* 退不回去就算了，别把原始错误盖掉 */
    }
    throw error
  }
}

export function closeDatabase(db) {
  try {
    db.close()
  } catch {}
}
