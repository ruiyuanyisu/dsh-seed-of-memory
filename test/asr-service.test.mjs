import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { transcribeFile } from '../lib/qq/media.js'

/** 起一个假的 ASR 服务，做完就关掉。 */
const withServer = (handler, fn) =>
  new Promise((resolve, reject) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address()
      try {
        await fn(`http://127.0.0.1:${port}`)
        resolve()
      } catch (error) {
        reject(error)
      } finally {
        server.close()
      }
    })
  })

const reply = (value) => (req, res) => {
  req.on('data', () => {})
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(value))
  })
}

test('配了常驻服务就先问它，不碰脚本', async () => {
  await withServer(reply({ text: '老大，我在呢。', duration: 3.7 }), async (url) => {
    const result = await transcribeFile({ asrUrl: url }, 'x.wav')
    assert.equal(result.ok, true)
    assert.equal(result.text, '老大，我在呢。')
    assert.equal(result.duration, 3.7)
    assert.equal(result.via, 'service', '走的是常驻服务，日志里才看得出快在哪')
  })
})

test('服务连不上时，退回本地脚本；脚本也没配就说清是哪条路断的', async () => {
  const result = await transcribeFile({ asrUrl: 'http://127.0.0.1:1' }, 'x.wav')
  assert.equal(result.ok, false)
  assert.equal(result.via, 'script')
  assert.match(result.error, /asr 服务不可用/)
  assert.match(result.error, /本地脚本也没配好/)
})

test('没配 asrUrl 就只走脚本', async () => {
  const result = await transcribeFile({}, 'x.wav')
  assert.equal(result.ok, false)
  assert.equal(result.via, 'script')
  assert.equal(result.error, 'asr 未配置')
})

test('服务回了空文本，也算没听见', async () => {
  await withServer(reply({ text: '   ' }), async (url) => {
    const result = await transcribeFile({ asrUrl: url }, 'x.wav')
    assert.equal(result.ok, false)
    assert.match(result.error, /没给出文本/)
  })
})
