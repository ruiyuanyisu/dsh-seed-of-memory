/**
 * 原 test-identity-cache.mjs：根/我是谁/我们 这三份文件的缓存。
 * 他把 self.md 换成目录再恢复，看 anchors 改了能不能重新读到（#mtime Infinity 那个坑）。
 * 我这里做同一件事，另外验一份读不了时只少那一段，别把另外两份一起丢掉。
 */
import { assert, drop, mkStore, pass } from './_lib.mjs'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IdentityFiles } from '../../lib/identity.js'

const ctx = mkStore('seed-review-identity-')
try {
  const dir = join(ctx.dir, 'identity')
  const files = new IdentityFiles(dir).ensure()
  const anchors = join(dir, 'anchors.md')
  const self = join(dir, 'self.md')
  const us = join(dir, 'us.md')

  writeFileSync(anchors, '# 根\n- 我叫阿鱼。\n', 'utf8')
  assert.ok(files.read().text.includes('我叫阿鱼'), '第一遍该读到')

  // ① 三份文件都在时：改了内容、同一毫秒内也该看见（这里靠 mtime 变化，落盘即可）
  writeFileSync(anchors, '# 根\n- 我叫阿鱼，善良是底线。\n', 'utf8')
  assert.ok(files.read().text.includes('善良是底线'), '改了根该重读')

  // ② self.md 被换成目录：不该抛，也不该把 anchors 一起丢
  rmSync(self, { force: true })
  mkdirSync(self, { recursive: true })
  const broken = files.read()
  assert.ok(broken.text.includes('善良是底线'), '一份读不了，另外两份还得在')

  // ③ 恢复成文件：内容要能重新读到（缓存不能一直记着「那次坏了」）
  rmSync(self, { recursive: true, force: true })
  writeFileSync(self, '# 我是谁\n- 蓝头发，尾巴收在裙子底下。\n', 'utf8')
  assert.ok(files.read().text.includes('蓝头发'), '恢复后该重新读到')

  // ④ us.md 一行一行加，重复的不重复加
  files.append('us', '他答应亲口讲故事给我听。')
  files.append('us', '他答应亲口讲故事给我听。')
  const twice = files.read().text.split('他答应亲口讲故事给我听。').length - 1
  assert.equal(twice, 1, '同一句只写一次')
  assert.ok(us && files.read().text.includes('他答应亲口讲故事给我听。'))

  pass('identity-cache：三份根文件改了会重读；一份坏了不连坐；重复的句子只写一次')
} finally {
  drop(ctx)
}
