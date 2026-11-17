import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../lib/db.js'
import {
  setContact,
  getContact,
  listContacts,
  forgetContact,
  contactLine,
  parsePeer,
  CONTACT_FIELDS,
} from '../lib/contacts.js'

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), 'seed-'))
  const db = openDatabase(path.join(dir, 'seed.db'))
  return { db, dir }
}

function done(ctx) {
  ctx.db.close()
  rmSync(ctx.dir, { recursive: true, force: true })
}

test('熟人卡：写一张、读一张，字段都在', () => {
  const ctx = fresh()
  try {
    const row = setContact(ctx.db, {
      peer: 'private:100000001',
      name: '雁雪',
      relation: '老朋友',
      birthday: '3-14',
      likes: '夜里听雨',
      notes: '别催',
    })
    assert.equal(row.peer, 'private:100000001')
    assert.deepEqual(CONTACT_FIELDS, ['name', 'relation', 'birthday', 'likes', 'notes'])
    const got = getContact(ctx.db, 'private:100000001')
    assert.equal(got.name, '雁雪')
    assert.equal(got.birthday, '3-14')
    assert.equal(got.notes, '别催')
  } finally {
    done(ctx)
  }
})

test('熟人卡：只改一个字段，别的还在（不整张重写）', () => {
  const ctx = fresh()
  try {
    setContact(ctx.db, { peer: 'group:200000001', name: '群', relation: '熟的' })
    setContact(ctx.db, { peer: 'group:200000001', likes: '游戏二创' })
    const got = getContact(ctx.db, 'group:200000001')
    assert.equal(got.name, '群')
    assert.equal(got.relation, '熟的')
    assert.equal(got.likes, '游戏二创')
  } finally {
    done(ctx)
  }
})

test('熟人卡：peer 写得不对就不建', () => {
  const ctx = fresh()
  try {
    assert.equal(setContact(ctx.db, { peer: '100000001', name: '谁' }), null)
    assert.equal(setContact(ctx.db, { peer: '', name: '谁' }), null)
    assert.deepEqual(parsePeer('private:1'), { scope: 'private', peer: '1', key: 'private:1' })
    assert.equal(parsePeer('user:1'), null)
  } finally {
    done(ctx)
  }
})

test('熟人卡：一行话读得懂，太长会收住', () => {
  const ctx = fresh()
  try {
    const row = setContact(ctx.db, {
      peer: 'private:1',
      name: '阿姨',
      relation: '家里人',
      likes: '好'.repeat(400),
    })
    const line = contactLine(row)
    assert.match(line, /^\[熟人\] 阿姨（QQ 私聊）/)
    assert.match(line, /关系 家里人/)
    assert.ok(line.length <= 180)
  } finally {
    done(ctx)
  }
})

test('熟人卡：列表和删除', () => {
  const ctx = fresh()
  try {
    setContact(ctx.db, { peer: 'private:1', name: '甲' })
    setContact(ctx.db, { peer: 'private:2', name: '乙' })
    const rows = listContacts(ctx.db)
    assert.equal(rows.length, 2)
    assert.equal(forgetContact(ctx.db, 'private:1'), true)
    assert.equal(forgetContact(ctx.db, 'private:1'), false)
    assert.equal(listContacts(ctx.db).length, 1)
  } finally {
    done(ctx)
  }
})

// —— 面板（lib/client.js）的熟人卡：结构不能退化 ——
import { readFileSync } from 'node:fs'

const clientSource = () => readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('熟人卡面板能收生日（原来后端有、前端没有）', () => {
  const src = clientSource()
  assert.match(src, /\['birthday', '生日'\]/, '表单/卡片里要有生日这一行')
})

test('熟人卡是就地编辑，不是删了重写', () => {
  const src = clientSource()
  assert.match(src, /const beginEdit = \(/, '点一下改')
  assert.match(src, /const commitEdit = \(/, '回车/失焦落盘')
  assert.match(src, /const cancelEdit = \(/, 'Esc 撤回')
  assert.doesNotMatch(src, /placeholder: 'private:100000001 或 group:200000001'/, '不该再让人手打带前缀的 peer')
})

test('熟人卡表单把 peer 拆成「类型 + 号」两段', () => {
  const src = clientSource()
  assert.match(src, /scope === 'group' \? '群号' : '对方的 QQ 号'/)
  assert.match(src, /`存成 \$\{scope\}:\$\{id\.trim\(\) \|\| '…'\}`/)
})

test('未完话头显示剩余时间，过期的标红', () => {
  const src = clientSource()
  assert.match(src, /const due = \(row\) =>/, '要有到期计算')
  assert.match(src, /'已过期'/)
  assert.match(src, /som-late/)
})
