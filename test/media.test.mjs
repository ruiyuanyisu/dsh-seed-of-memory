import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  recordSegments,
  looksSpeakable,
  resolveRecordFile,
  synthesizeToFile,
  voiceFileName,
} from '../lib/qq/media.js'

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
