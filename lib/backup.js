/**
 * 每天一份安全快照。
 *
 * 记忆是越攒越贵的东西，改错一次、盘满一次就没了。
 * 所以启动时顺手用 SQLite 的 VACUUM INTO 拷一份完整库（比复制文件安全：
 * 它会带上 WAL 里还没落盘的内容，也不会抄到半条事务）。
 *
 * 规则很克制：
 *   - 一天最多一份，同一天重复启动不会重复写；
 *   - 只留最近 keep 份（默认 3），旧的自动删；
 *   - 任何异常都只打一条 warn，绝不影响插件启动。
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const BACKUP_PREFIX = 'seed.db-backup-'

/**
 * 这份备份真能用吗？
 *
 * 以前 `VACUUM INTO` 完就当它是「安全网」，从不回头看。
 * 盘满、进程被杀、目标路径正好跨盘时，会拷出一份打不开的半截库——
 * 等到真要恢复那天才发现，等于没有备份（REVIEW-151 第十八轮 ⑪）。
 */
export function verifyBackup(path) {
  let probe = null
  try {
    // 0 字节的 SQLite 是「一个合法的空库」：integrity_check 会老老实实返回 ok，
    // 于是半截备份也算过（REVIEW-152 第八轮）。先看它到底有没有东西。
    if (!existsSync(path)) return false
    if (statSync(path).size < 1024) return false
    probe = new DatabaseSync(path, { readOnly: true })
    const tables = probe.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get()
    if (!Number(tables?.n)) return false
    const row = probe.prepare('PRAGMA integrity_check').get()
    return String(row?.integrity_check ?? '') === 'ok'
  } catch {
    return false
  } finally {
    try {
      probe?.close()
    } catch {
      /* 关不掉也没别的可做 */
    }
  }
}

function stampOf(now = Date.now()) {
  const when = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
}

/** `seed.db-backup-2026-11-14` */
export function backupName(now = Date.now()) {
  return BACKUP_PREFIX + stampOf(now)
}

/** 只认「真备份」：`seed.db-backup-YYYY-MM-DD` 那种文件名，目录和别的文件都不算。 */
const BACKUP_NAME = /^seed\.db-backup-\d{4}-\d{2}-\d{2}$/

function isBackupFile(dir, name) {
  if (!BACKUP_NAME.test(name)) return false
  try {
    return statSync(join(dir, name)).isFile()
  } catch {
    return false
  }
}

/** 目录里现有的备份文件名，旧的在前（文件名里的日期可以直接按字符串排）。 */
export function listBackups(dir) {
  if (!dir || !existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((name) => isBackupFile(dir, name))
      .sort()
  } catch {
    return []
  }
}

/** 只留最近 keep 份；返回真正删掉的文件名。 */
export function pruneBackups(dir, keep = 3) {
  const names = listBackups(dir)
  const limit = Math.max(1, Number(keep) || 3)
  const doomed = names.slice(0, Math.max(0, names.length - limit))
  const removed = []
  for (const name of doomed) {
    try {
      rmSync(join(dir, name), { force: true })
      removed.push(name)
    } catch {
      /* 删不掉就算了，下次再说 */
    }
  }
  return removed
}

/**
 * 今天还没备份就做一份。
 * @returns {string|null} 新备份的完整路径；跳过或失败时返回 null。
 */
export function backupDaily(db, dbPath, dir, { keep = 3, now = Date.now() } = {}) {
  try {
    if (!dbPath || !dir || !existsSync(dbPath)) return null
    const target = join(dir, backupName(now))
    if (existsSync(target)) return null
    const quoted = target.replace(/'/g, "''")
    db.exec(`VACUUM INTO '${quoted}'`)
    if (!verifyBackup(target)) {
      // 拷出来的东西打不开或过不了完整性检查：删掉它。
      // 留着一份用不了的「安全网」比没有更糟 —— 出事那天你会以为有退路。
      try {
        rmSync(target, { force: true })
      } catch {
        /* ignore */
      }
      console.warn('[seed-of-memory] 每日备份校验没通过，已删掉那一份')
      return null
    }
    pruneBackups(dir, keep)
    return target
  } catch (error) {
    console.warn('[seed-of-memory] 每日备份失败：' + (error?.message ?? error))
    return null
  }
}

/** 备份占多大（字节），给状态面板用。 */
export function backupStatus(dir) {
  const names = listBackups(dir)
  let bytes = 0
  for (const name of names) {
    try {
      bytes += statSync(join(dir, name)).size
    } catch {
      /* ignore */
    }
  }
  return { count: names.length, bytes, latest: names.at(-1) ?? null }
}
