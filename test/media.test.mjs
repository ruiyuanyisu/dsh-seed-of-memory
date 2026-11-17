import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  asrArgs,
  recordSegments,
  looksSpeakable,
  resolveRecordFile,
  synthesizeToFile,
  voiceFileName,
  pruneVoiceFiles,
  pruneImageFiles,
} from '../lib/qq/media.js'

test('ASR 命令行：默认 small，设备/精度配了才加参数', () => {
  assert.deepEqual(asrArgs({}, 'C:/a.wav', 'asr.py'), ['asr.py', 'C:/a.wav', '--model', 'small'])
  assert.deepEqual(asrArgs({ asrModel: 'C:/m/large-v3', asrModelsDir: 'C:/m' }, 'C:/a.wav', 'asr.py'), [
    'asr.py',
    'C:/a.wav',
    '--model',
    'C:/m/large-v3',
    '--models-dir',
    'C:/m',
  ])
  assert.deepEqual(asrArgs({ asrDevice: 'cpu', asrComputeType: 'int8' }, 'C:/a.wav', 'asr.py'), [
    'asr.py',
    'C:/a.wav',
    '--model',
    'small',
    '--device',
    'cpu',
    '--compute-type',
    'int8',
  ])
})

test('recordSegments 只挑语音段', () => {
  const segments = [
    { type: 'text', data: { text: 'hi' } },
    { type: 'record', data: { file: 'a.wav' } },
    { type: 'image', data: { file: 'b.png' } },
  ]
  assert.equal(recordSegments(segments).length, 1)
  assert.equal(recordSegments(null).length, 0)
})

test('looksSpeakable 控制长度与格式', () => {
  assert.equal(looksSpeakable('记得呀，我在。', 80), true)
  assert.equal(looksSpeakable('长'.repeat(81), 80), false)
  assert.equal(looksSpeakable('看这个 https://example.com', 80), false)
  assert.equal(looksSpeakable('```js\nx\n```', 80), false)
  assert.equal(looksSpeakable('', 80), false)
})

test('resolveRecordFile 直接接受本地 wav', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-voice-'))
  try {
    const file = join(dir, 'demo.wav')
    writeFileSync(file, Buffer.from('RIFF....WAVE'))
    const got = await resolveRecordFile({ client: null, seg: { type: 'record', data: { file } }, dir })
    assert.equal(got, file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('synthesizeToFile 未配置时安静失败', async () => {
  const result = await synthesizeToFile({}, '测试')
  assert.equal(result.ok, false)
  assert.match(result.error, /tts/)
})

test('voiceFileName 只取文件名', () => {
  assert.equal(voiceFileName('C:\\tmp\\a.wav'), 'a.wav')
})

test('合成出来的语音不会无限攒着：旧的清掉、别人的文件不碰', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-voice-'))
  try {
    const now = 1_800_000_000_000
    const made = []
    for (let index = 0; index < 45; index += 1) {
      const file = join(dir, `say-${now - index * 1000}-abcdef.wav`)
      writeFileSync(file, 'x')
      utimesSync(file, new Date(now - index * 1000), new Date(now - index * 1000))
      made.push(file)
    }
    // 一个很旧的、名字不在我们规则里的文件，不该被清掉
    const manual = join(dir, 'manual-test.wav')
    writeFileSync(manual, 'x')
    utimesSync(manual, new Date(now - 400 * 86_400_000), new Date(now - 400 * 86_400_000))

    const result = pruneVoiceFiles(dir, { keep: 40, now })
    assert.equal(result.removed, 5, '超出最近 40 份之外的应该删掉')
    assert.equal(existsSync(manual), true, '不是我们写的文件别动')
    assert.equal(existsSync(made[0]), true, '最新的留着')
    assert.equal(existsSync(made[44]), false, '最旧的清掉')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('pruneImageFiles：只按天数清，超过 7 天的图删掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-img-'))
  try {
    const now = Date.now()
    const fresh = join(dir, '1794837098795-64daffd0.jpg')
    const old = join(dir, '1700000000000-1231c4bf.png')
    const justUnder = join(dir, '1700000000001-abcdef12.webp')
    const other = join(dir, 'keep-me.txt')

    writeFileSync(fresh, 'x')
    writeFileSync(old, 'x')
    writeFileSync(justUnder, 'x')
    writeFileSync(other, 'x')

    // 8 天前的删、6 天前的留
    utimesSync(old, new Date(now - 8 * 86_400_000), new Date(now - 8 * 86_400_000))
    utimesSync(justUnder, new Date(now - 6 * 86_400_000), new Date(now - 6 * 86_400_000))
    utimesSync(other, new Date(now - 30 * 86_400_000), new Date(now - 30 * 86_400_000))

    const result = pruneImageFiles(dir, { now })
    assert.equal(result.removed, 1, '只删那 1 张超过 7 天的图')
    assert.equal(existsSync(old), false, '8 天前的删掉')
    assert.equal(existsSync(justUnder), true, '6 天前的留着')
    assert.equal(existsSync(fresh), true, '刚收的留着')
    assert.equal(existsSync(other), true, '不是图片后缀的一律不碰')

    // 目录不存在时别抛
    assert.deepEqual(pruneImageFiles(join(dir, 'nope'), { now }), { removed: 0 })
    assert.deepEqual(pruneImageFiles('', { now }), { removed: 0 })
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})
