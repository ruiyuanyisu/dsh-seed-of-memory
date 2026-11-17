import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { segmentsOf, imageSegments, textOf } from '../lib/qq/message.js'
import { resolveImageFile } from '../lib/qq/media.js'
import { routeOf } from '../lib/qq/routes.js'

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'som-image-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('QQ 发来的图：从消息里挑得出来', () => {
  const segments = segmentsOf([
    { type: 'text', data: { text: '你看这个' } },
    { type: 'image', data: { file: 'a.jpg', url: 'http://example.com/a.jpg' } },
  ])
  const images = imageSegments(segments)
  assert.equal(images.length, 1)
  assert.equal(images[0].data.file, 'a.jpg')
  assert.equal(textOf(segments), '你看这个')
})

test('CQ 码里的图也认得', () => {
  const segments = segmentsOf('看[CQ:image,file=b.png,url=http://example.com/b.png]这张')
  const images = imageSegments(segments)
  assert.equal(images.length, 1)
  assert.equal(images[0].type, 'image')
  assert.equal(images[0].data.file, 'b.png')
  // 正文只留文字，图片不混进去
  assert.equal(textOf(segments), '看这张')
})

test('图已经在本机，直接给路径，不用再拉一遍', async () => {
  const { dir, done } = scratch()
  try {
    const file = join(dir, 'local.png')
    writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'))
    const got = await resolveImageFile({ client: null, seg: { data: { file } }, dir, logger: {} })
    assert.equal(got, file)
  } finally {
    done()
  }
})

test('拿到 base64 就落盘，后缀按 url 猜', async () => {
  const { dir, done } = scratch()
  try {
    const payload = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
    const client = {
      call: async () => ({ file: `base64://${payload}` }),
    }
    const got = await resolveImageFile({
      client,
      seg: { data: { file: 'whatever', url: 'http://example.com/x.webp' } },
      dir,
      logger: {},
    })
    assert.ok(got, '应该落下来一个文件')
    assert.match(got, /\.webp$/)
  } finally {
    done()
  }
})

test('什么都没有就返回空，不抛错', async () => {
  const { dir, done } = scratch()
  try {
    const got = await resolveImageFile({ client: null, seg: { data: {} }, dir, logger: {} })
    assert.equal(got, '')
  } finally {
    done()
  }
})

test('白名单里的人没配路由，也放进来', () => {
  const config = {
    allowPrivate: ['100000002'],
    allowGroups: [],
    routes: [
      { id: 'owner', cwd: 'D:\\work', accept: { private: ['100000001'], groups: [] } },
    ],
  }
  const ev = { post_type: 'message', message_type: 'private', user_id: 100000002, sender: { user_id: 100000002 } }
  const out = routeOf(ev, config, { now: Date.now(), orders: [] })
  assert.equal(out.allow, true, '白名单里的人在，不该被挡')
  assert.match(out.reason, /白名单/)
})

test('既不在白名单、也没有路由，还是挡住', () => {
  const config = {
    allowPrivate: ['100000002'],
    routes: [
      { id: 'owner', cwd: 'D:\\work', accept: { private: ['100000001'], groups: [] } },
    ],
  }
  const ev = { post_type: 'message', message_type: 'private', user_id: 999, sender: { user_id: 999 } }
  const out = routeOf(ev, config, { now: Date.now(), orders: [] })
  assert.equal(out.allow, false)
})
