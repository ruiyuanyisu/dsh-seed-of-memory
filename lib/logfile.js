/**
 * 日志别无限长，也别一涨就把之前的全抹掉。
 *
 * 原来的做法是「超过 400KB 就清空」——出问题的时候最想看的就是那一段，
 * 偏偏被清掉了。现在改成轮转：太长了就把当前这份改名成 `qq.log.1`
 * （只留一份旧的，总占用还是两倍上限），再从头写。
 */
import { renameSync, statSync, writeFileSync } from 'node:fs'

export const LOG_MAX_BYTES = 400_000

/**
 * @returns {'rotated'|'reset'|'kept'} 做了什么
 */
export function rotateLog(file, { maxBytes = LOG_MAX_BYTES, keep = 1 } = {}) {
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    return 'kept' // 还没有这份日志
  }
  if (!(size > maxBytes)) return 'kept'

  if (keep > 0) {
    try {
      renameSync(file, `${file}.${keep}`)
      return 'rotated'
    } catch {
      /* 改名不成（被占着/跨盘），退回清空 */
    }
  }
  try {
    writeFileSync(file, '', 'utf8')
    return 'reset'
  } catch {
    return 'kept'
  }
}
