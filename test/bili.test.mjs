import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { parseReport, collectBiliCandidates, summarizeReports } from '../lib/bili.js'

const SAMPLE = `# 刷B站日报 2026-11-12

## 又刷了一轮 · 2026-11-12

### BV1b33xzwE3c
白厄×尼采的永恒轮回 · 佐sa木 · https://www.bilibili.com/video/BV1b33xzwE3c
**档位**：值得看 · 把「命运之爱」扣在 3000 万次轮回上，15 分钟没水分。

### BV17qHc6pEA5
我给dsh做了个超便宜的看视频插件！ · 苍穹晓雷 · https://www.bilibili.com/video/BV17qHc6pEA5
**档位**：可以看 · 场景变换检测 + 多帧拼一张。

### 不是视频的小节
这行不该被当成条目。
`

test('parseReport 提取 BV 号、标题、作者、链接与档位', () => {
  const entries = parseReport(SAMPLE)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].videoId, 'BV1b33xzwE3c')
  assert.equal(entries[0].title, '白厄×尼采的永恒轮回')
  assert.equal(entries[0].author, '佐sa木')
  assert.equal(entries[0].url, 'https://www.bilibili.com/video/BV1b33xzwE3c')
  assert.match(entries[0].verdict, /值得看/)
  assert.equal(entries[1].videoId, 'BV17qHc6pEA5')
})

test('summarizeReports 统计档位与最新日期', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-bili-'))
  try {
    writeFileSync(join(dir, '2026-11-12.md'), SAMPLE, 'utf8')
    writeFileSync(join(dir, '2026-10-01.md'), '# 太早了\n', 'utf8')
    const now = new Date('2026-11-13T08:00:00').getTime()
    const summary = summarizeReports({ dir, days: 7, now })
    assert.deepEqual(summary, { files: 1, lastDay: '2026-11-12', total: 2, worth: 1, okay: 1 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('collectBiliCandidates 收「值得看」和「可以看」', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-bili-'))
  try {
    writeFileSync(join(dir, '2026-11-12.md'), SAMPLE, 'utf8')
    const now = new Date('2026-11-13T08:00:00').getTime()
    const candidates = collectBiliCandidates({ dir, days: 3, now })
    assert.equal(candidates.length, 2)
    assert.equal(candidates[0].videoId, 'BV1b33xzwE3c')
    assert.match(candidates[0].text, /值得看/)
    assert.match(candidates[0].text, /白厄×尼采的永恒轮回/)
    assert.equal(candidates[1].videoId, 'BV17qHc6pEA5')
    assert.match(candidates[1].text, /可以看/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
