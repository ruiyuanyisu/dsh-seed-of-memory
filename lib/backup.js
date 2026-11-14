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

export const BACKUP_PREFIX = 'seed.db-backup-'

function stampOf(now = Date.now()) {
  const when = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
}

/** `seed.db-backup-2026-11-14` */
export function backupName(now = Date.now()) {
  return BACKUP_PREFIX + stampOf(now)
}

/** 目录里现有的备份文件名，旧的在前（文件名里的日期可以直接按字符串排）。 */
export function listBackups(dir) {
  if (!dir || !existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(BACKUP_PREFIX))
      .sort()
  } catch {
    return []
  }
}

/** 只留最近 keep 份；返回被删掉的文件名。 */
export function pruneBackups(dir, keep = 3) {
  const names = listBackups(dir)
  const limit = Math.max(1, Number(keep) || 3)
  const doomed = names.slice(0, Math.max(0, names.length - limit))
  for (const name of doomed) {
    try {
      rmSync(join(dir, name), { force: true })
    } catch {
      /* 删不掉就算了，下次再说 */
    }
  }
  return doomed
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
