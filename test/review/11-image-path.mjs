/**
 * 原 test-inject-path / test-image-path.mjs：图片路径白名单——手打一行不能当读取器用。
 * 我的实现校验在 channel 的 #imageBlocksFor 里（IMAGE_FILE_RE + 跳过的日志）。
 * 这里从源码里取那条正则（而不是在测试里抄一份），再拿十个样例过一遍：
 * 测试里抄一份正则，改代码时就会「测试绿、代码漏」。
 */
import { assert, pass, src } from './_lib.mjs'

const code = src('lib/qq/channel.js')
const found = code.match(/const IMAGE_FILE_RE = (\/.*\/[a-z]*)/)
assert.ok(found, 'channel 里该有 IMAGE_FILE_RE')
const re = eval(found[1])

const allowed = ['a.jpg', 'b.JPEG', 'c.png', 'd.webp', 'e.gif', 'f.bmp']
const denied = [
  'C:\\Windows\\win.ini',
  'secret.txt',
  'passwords.json',
  'evil.png.exe',
  'id_rsa',
  'a.png.bak',
]
for (const name of allowed) assert.ok(re.test(name), `该放行：${name}`)
for (const name of denied) assert.ok(!re.test(name), `该拦住：${name}`)

// 还要确认它是「先判再读」：读文件那行前面得有 image-skip 那条日志
const guardAt = code.indexOf('IMAGE_FILE_RE.test(path)')
const readAt = code.indexOf('readFileSync(path)')
assert.ok(guardAt > 0 && readAt > guardAt, '白名单要在 readFileSync 之前')
assert.ok(code.includes("pushLog('image-skip'"), '拦下来的时候要留一条日志')

pass('image-path：只认图片后缀，先判再读，拦下来会记日志')
