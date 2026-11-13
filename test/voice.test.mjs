import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asrConfigStatus, probeTts, voiceCapability, VoiceProbe, VOICE_NOTICE } from '../lib/voice.js'

test('ASR 没配置时给得出原因', () => {
  const status = asrConfigStatus({})
  assert.equal(status.ok, false)
  assert.match(status.reason, /没配置语音识别/)

  const noPython = asrConfigStatus({ asrScript: 'x.py' })
  assert.equal(noPython.ok, false)
  assert.match(noPython.reason, /asrPython/)

  const missing = asrConfigStatus({ asrPython: 'python', asrScript: 'C:/definitely/not/here.py' })
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /脚本不存在/)
})

test('ASR 脚本存在才算可用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-voice-'))
  const script = join(dir, 'asr.py')
  writeFileSync(script, 'print(1)', 'utf8')
  const status = asrConfigStatus({ asrPython: 'python', asrScript: script })
  assert.equal(status.ok, true)
})

test('TTS 没配地址 / 连不上 / 连得上都说得清', async () => {
  assert.equal((await probeTts('')).ok, false)

  const down = await probeTts('http://127.0.0.1:1', { fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal(down.ok, false)
  assert.match(down.reason, /连不上/)

  const up = await probeTts('http://127.0.0.1:9880/', { fetchImpl: async () => ({ status: 404 }) })
  assert.equal(up.ok, true)
})

test('voiceCapability 汇总听/说与纯文字', async () => {
  const ok = await voiceCapability(
    { ttsUrl: 'http://127.0.0.1:9880' },
    { fetchImpl: async () => ({ status: 200 }) },
  )
  assert.equal(ok.tts.ok, true)
  assert.equal(ok.asr.ok, false)
  assert.equal(ok.textOnly, false)

  const textOnly = await voiceCapability({}, { fetchImpl: async () => { throw new Error('nope') } })
  assert.equal(textOnly.textOnly, true)
  assert.equal(textOnly.any, false)
})

test('VoiceProbe 在 TTL 内复用，force 才重探', async () => {
  let calls = 0
  let clock = 0
  const probe = new VoiceProbe({
    ttlMs: 1000,
    now: () => clock,
    probe: async () => {
      calls += 1
      return { tts: { ok: true }, asr: { ok: false }, textOnly: false }
    },
  })
  const config = { ttsUrl: 'http://127.0.0.1:9880' }
  await probe.get(config)
  assert.equal(calls, 1)
  clock = 500
  await probe.get(config)
  assert.equal(calls, 1)
  clock = 1500
  await probe.get(config)
  assert.equal(calls, 2)
  await probe.get(config, { force: true })
  assert.equal(calls, 3)
})

test('提示文案不吓人', () => {
  assert.match(VOICE_NOTICE, /语音/)
})
