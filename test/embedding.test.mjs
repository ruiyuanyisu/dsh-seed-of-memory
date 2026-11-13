import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { EmbeddingRuntime } from '../lib/embedding.js'

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('scan 只认像安装包的 zip，且忽略过小的文件', () => {
  const dir = tmpdir('seed-scan-')
  const scanDir = path.join(dir, 'Downloads')
  fs.mkdirSync(scanDir)
  fs.writeFileSync(path.join(scanDir, 'seed-embed-runtime-bge-small-v1.0.0.zip'), Buffer.alloc(11 * 1024 * 1024))
  fs.writeFileSync(path.join(scanDir, 'other.zip'), Buffer.alloc(11 * 1024 * 1024))
  fs.writeFileSync(path.join(scanDir, 'seed-embed-runtime-broken.zip'), Buffer.alloc(1024))

  const runtime = new EmbeddingRuntime({ stateDir: dir, port: 11499, extraScanDirs: [scanDir], home: dir })
  const found = runtime.scan()
  assert.equal(found.length, 1)
  assert.match(found[0].name, /^seed-embed-runtime-.+\.zip$/)
})

test('status 在未安装时是 installed=false / running=false', async () => {
  const dir = tmpdir('seed-status-')
  const runtime = new EmbeddingRuntime({ stateDir: dir, port: 11499 })
  const status = await runtime.status()
  assert.equal(status.installed, false)
  assert.equal(status.running, false)
  assert.equal(status.dimension, 512)
  assert.match(status.endpoint, /11499$/)
})

test('install 拒绝不存在的文件与过小的文件', async () => {
  const dir = tmpdir('seed-install-')
  const runtime = new EmbeddingRuntime({ stateDir: dir, port: 11499 })
  assert.equal((await runtime.install(path.join(dir, 'nope.zip'))).ok, false)
  const small = path.join(dir, 'seed-embed-runtime-small.zip')
  fs.writeFileSync(small, Buffer.alloc(1024))
  const result = await runtime.install(small)
  assert.equal(result.ok, false)
  assert.match(result.error, /不完整/)
})

test('install 拒绝没有 VERSION.json 标记的压缩包', async (t) => {
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  if (!fs.existsSync(tar)) return t.skip('没有 tar.exe')
  const dir = tmpdir('seed-badpack-')
  const src = path.join(dir, 'src')
  fs.mkdirSync(path.join(src, 'runtime', 'ollama-models'), { recursive: true })
  fs.writeFileSync(path.join(src, 'runtime', 'ollama.exe'), 'not a real exe')
  fs.writeFileSync(path.join(src, 'VERSION.json'), JSON.stringify({ pack: 'something-else', version: '1.0.0' }))
  const zip = path.join(dir, 'seed-embed-runtime-bad.zip')
  const packed = spawnSync(tar, ['-a', '-cf', zip, '-C', src, '.'])
  if (packed.status !== 0) return t.skip('tar 无法创建 zip')
  fs.truncateSync(zip, Math.max(fs.statSync(zip).size, 10 * 1024 * 1024))
  const runtime = new EmbeddingRuntime({ stateDir: dir, port: 11499 })
  const result = await runtime.install(zip)
  assert.equal(result.ok, false)
  assert.match(result.error, /不是 Seed Embedding Runtime/)
})

test('embed 在没有运行时的时候返回错误而不是抛异常', async () => {
  const dir = tmpdir('seed-embed-')
  const runtime = new EmbeddingRuntime({ stateDir: dir, port: 11499 })
  const result = await runtime.embed(['她怕冷'])
  assert.equal(result.ok, false)
  assert.ok(result.error)
})
