import { statfsSync } from 'node:fs'

export const DEFAULT_MIN_FREE_MB = 300

function mb(bytes) {
  return Math.round((Number(bytes) || 0) / 1024 / 1024)
}

/**
 * Free space of the volume that holds the memory database.
 *
 * `statfsFn` is injectable so tests don't depend on the machine's disk.
 * Returns null when the volume can't be inspected (e.g. exotic filesystems) —
 * a missing reading must never block the plugin.
 */
export function diskStatus(dir, options = {}) {
  const { statfsFn = statfsSync, minFreeMB = DEFAULT_MIN_FREE_MB, now = Date.now() } = options
  let stats = null
  try {
    stats = statfsFn(dir)
  } catch {
    return null
  }
  if (!stats) return null
  const blockSize = Number(stats.bsize) || 0
  const totalBytes = blockSize * (Number(stats.blocks) || 0)
  const freeBytes = blockSize * (Number(stats.bavail ?? stats.bfree) || 0)
  const freeMB = mb(freeBytes)
  const threshold = Number.isFinite(Number(minFreeMB)) ? Math.max(1, Math.round(Number(minFreeMB))) : DEFAULT_MIN_FREE_MB
  return {
    path: dir,
    totalBytes,
    freeBytes,
    totalMB: mb(totalBytes),
    freeMB,
    minFreeMB: threshold,
    low: freeMB < threshold,
    checkedAt: now,
  }
}

/** One short line for the injected card; '' when there is enough room. */
export function storageLine(status) {
  if (!status?.low) return ''
  return `[存储] 记忆目录所在磁盘只剩 ${status.freeMB} MB（低于 ${status.minFreeMB} MB 阈值）：请清理或把 ${status.path} 搬到更大的盘；在此之前新记忆可能写不进去。`
}
