/**
 * 审查包 24 个脚本的跑法：`node test\review\run.mjs`。
 * 一个文件一个进程（互不污染），一个文件只问一件事，末了汇总。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here)
  .filter((f) => /^\d+-.+\.mjs$/.test(f))
  .sort()

let ok = 0
const failed = []
for (const file of files) {
  const res = spawnSync(process.execPath, [join(here, file)], { stdio: 'inherit' })
  if (res.status === 0) ok += 1
  else failed.push(file)
}

const total = files.length
console.log('')
console.log(`审查包搬过来的 ${total} 项：${ok} 过，${failed.length} 没过`)
if (failed.length) {
  console.log('没过的：')
  for (const file of failed) console.log(`  - ${file}`)
  process.exitCode = 1
}
