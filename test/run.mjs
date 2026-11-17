/**
 * 跑测试的统一入口。
 *
 * 两个用处：
 * 1. `node --test test/` 在新版 Node 上会 MODULE_NOT_FOUND，这里用通配符避开。
 * 2. 跑完把临时目录收干净 —— 之前跑一遍测试能在 C 盘留下几十个 126MB 的临时 home
 *    （一次攒出 40GB，C 盘剩 4.6GB 的那个事故就是这么来的）。
 *
 * 注意：临时目录**不换盘**。试过把 TEMP 指到 E 盘，同样 16 个用例从 0.5 秒变成 45 秒，
 * 慢 85 倍。所以还是用系统 TEMP，只靠「跑完删掉本次新增的」来兜底。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, rmSync } from 'node:fs'
import { tmpdir, freemem } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const temp = tmpdir()

// 并发开太大，一次能同时活七八个 home，每个解压 126MB 的 embedding 运行时，
// 内存峰值能顶到两三个 G —— 机器上同时开着 DSH 的话，整台机器会开始换页，
// DSH 的窗口就卡死不动（2026-11-16 下午撞过一次）。
// 默认按跑之前的可用内存挑并发：宽裕就 4，一般 2，很紧就 1（宁可慢也别把宿主压崩）。
const freeGB = freemem() / 1024 ** 3
const auto = freeGB < 4 ? 1 : freeGB < 6 ? 2 : 4
const concurrency = String(process.env.SOM_TEST_CONCURRENCY ?? auto)
if (freeGB < 4) {
  console.log(`\n[提醒] 可用内存只剩 ${freeGB.toFixed(1)}G，这次只开 ${concurrency} 路。`)
  console.log('       要是机器上还开着别的大程序（比如语音那个 python），它可能更饿。\n')
}

const ourName = (name) => /^(seed|som)[-.]/i.test(name)
const before = new Set(readdirSync(temp))

const extra = process.argv.slice(2)
const targets = extra.length ? extra : ['test/*.test.mjs']

const result = spawnSync(process.execPath, ['--test', `--test-concurrency=${concurrency}`, ...targets], {
  cwd: root,
  stdio: 'inherit',
})

// 崩了也收：只删这次跑出来的、名字是我们的那种目录。
let cleaned = 0
try {
  for (const name of readdirSync(temp)) {
    if (before.has(name) || !ourName(name)) continue
    try {
      rmSync(join(temp, name), { recursive: true, force: true, maxRetries: 3 })
      cleaned++
    } catch {
      /* 删不掉就算了，下次开跑还会再试 */
    }
  }
} catch {
  /* 读不了临时目录也不影响测试结果 */
}

if (cleaned > 0) console.log(`\n收走了 ${cleaned} 个临时目录`)

process.exit(result.status ?? 1)
