import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPORT_NAME = /^(\d{4})-(\d{2})-(\d{2})\.md$/

/** Parse one daily report produced by dsh-bili-scroll. */
export function parseReport(text) {
  const entries = []
  let current = null
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    const head = /^###\s+(BV[0-9A-Za-z]+)\s*$/.exec(line)
    if (head) {
      if (current?.videoId && current.title) entries.push(current)
      current = { videoId: head[1], title: '', author: '', url: '', verdict: '', note: '' }
      continue
    }
    if (!current) continue
    const info = /^(.*?)\s*·\s*(.*?)\s*·\s*(https?:\/\/\S+)\s*$/.exec(line)
    if (info && !current.title) {
      current.title = info[1].replace(/^#+\s*/, '').trim()
      current.author = info[2].trim()
      current.url = info[3].trim()
      continue
    }
    const verdict = /^\*\*档位\*\*[：:]\s*(.*)$/.exec(line)
    if (verdict) current.verdict = verdict[1].trim()
  }
  if (current?.videoId && current.title) entries.push(current)
  return entries
}

/** List recent daily reports, newest first. */
export function recentReports(dir, { days = 3, now = Date.now() } = {}) {
  if (!existsSync(dir)) return []
  const since = now - Math.max(1, days) * 86_400_000
  const reports = []
  for (const name of readdirSync(dir)) {
    const match = REPORT_NAME.exec(name)
    if (!match) continue
    const day = `${match[1]}-${match[2]}-${match[3]}`
    const at = new Date(`${day}T00:00:00`).getTime()
    if (!Number.isFinite(at) || at < since) continue
    try {
      reports.push({ day, file: join(dir, name), text: readFileSync(join(dir, name), 'utf8') })
    } catch {
      /* 读不到就跳过 */
    }
  }
  return reports.sort((a, b) => (a.day < b.day ? 1 : -1))
}

/** Count the「值得看 / 可以看」entries in recent reports. */
export function summarizeReports({ dir, days = 7, now = Date.now() } = {}) {
  const reports = recentReports(dir, { days, now })
  let worth = 0
  let okay = 0
  let total = 0
  for (const report of reports) {
    for (const entry of parseReport(report.text)) {
      total += 1
      if (/值得看/.test(entry.verdict)) worth += 1
      else if (/可以看/.test(entry.verdict)) okay += 1
    }
  }
  return { files: reports.length, lastDay: reports[0]?.day ?? '', total, worth, okay }
}

/** Turn recent reports into capture candidates.「值得看」和「可以看」都收，
 * 其余档位（不用看 / 跳过 / 没字幕）忽略；`all: true` 时不限档位。
 */
export function collectBiliCandidates({ dir, days = 3, now = Date.now(), max = 8, all = false } = {}) {
  const out = []
  for (const report of recentReports(dir, { days, now })) {
    for (const entry of parseReport(report.text)) {
      const worth = /值得看/.test(entry.verdict)
      const okay = /可以看/.test(entry.verdict)
      if (!all && !worth && !okay) continue
      const mood = worth ? '值得看' : okay ? '可以看' : '看过'
      const detail = entry.verdict
        .replace(/^值得看\s*[·:：]?\s*/, '')
        .replace(/^可以看\s*[·:：]?\s*/, '')
      const head = `${report.day} 刷B站${mood}：《${entry.title}》${entry.author ? `（${entry.author}）` : ''}`
      const room = Math.max(24, 160 - head.length - 2)
      const shortDetail = detail.length > room ? `${detail.slice(0, room - 1)}…` : detail
      const text = `${head}${shortDetail ? `——${shortDetail}` : ''}`
      out.push({ day: report.day, videoId: entry.videoId, title: entry.title, url: entry.url, verdict: entry.verdict, text })
      if (out.length >= max) return out
    }
  }
  return out
}
