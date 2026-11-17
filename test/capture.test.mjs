import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase, closeDatabase } from '../lib/db.js'
import { SeedStore } from '../lib/store.js'
import {
  acceptCapture,
  addCapture,
  captureLine,
  captureStats,
  expireCaptures,
  extractCandidates,
  isKnown,
  listCaptures,
  markCapture,
  matchCapture,
} from '../lib/capture.js'

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'seed-capture-'))
  const db = openDatabase(join(dir, 'seed.db'))
  const store = new SeedStore(db, { dbPath: join(dir, 'seed.db') })
  try {
    return fn(db, store, dir)
  } finally {
    closeDatabase(db)
    rmSync(dir, { recursive: true, force: true })
  }
}

test('extractCandidates 只挑带线索的句子', () => {
  const text = '今天天气不错。我讨厌被人催。对了，以后不要再半夜发消息。'
  const got = extractCandidates(text)
  assert.equal(got.length, 2)
  assert.equal(got[0].cue, 'preference')
  assert.match(got[0].text, /我讨厌/)
  assert.equal(got[1].cue, 'agreement')
  assert.ok(got.every((c) => c.text.length >= 6))
})

test('extractCandidates 跳过太短/太长/无线索', () => {
  assert.equal(extractCandidates('好的').length, 0)
  assert.equal(extractCandidates('记住').length, 0)
  assert.equal(extractCandidates('今天吃了面。看了会儿书。').length, 0)
  const long = '记住 ' + '很长的句子'.repeat(80)
  assert.equal(extractCandidates(long).length, 0)
})

test('addCapture 去重并保留 pending', () => {
  return withDb((db) => {
    const a = addCapture(db, { sessionId: 's1', text: '我讨厌被人催。', cue: 'preference' })
    assert.ok(a)
    const b = addCapture(db, { sessionId: 's1', text: '我讨厌被人催！', cue: 'preference' })
    assert.equal(b, null)
    const rows = listCaptures(db)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, 'pending')
  })
})

test('isKnown 认得已有的记忆', () => {
  return withDb((db) => {
    const store = new SeedStore(db)
    store.remember({ text: '她讨厌被人催着做决定', layer: 'semantic' })
    assert.equal(isKnown(db, '她讨厌被人催着做决定。'), true)
    assert.equal(isKnown(db, '她喜欢下雨天'), false)
  })
})

test('matchCapture 在写入记忆后把对应候选标为 accepted', () => {
  return withDb((db) => {
    const store = new SeedStore(db)
    addCapture(db, { text: '她讨厌被人催着做决定', cue: 'preference' })
    const memory = store.remember({ text: '她讨厌被人催着做决定', layer: 'semantic' })
    const matched = matchCapture(db, '她讨厌被人催着做决定', memory.id)
    assert.ok(matched)
    const rows = listCaptures(db, { status: 'accepted' })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].memory_id, memory.id)
  })
})

test('acceptCapture 走正常写入并标记', () => {
  return withDb((db, store) => {
    const row = addCapture(db, { text: '她喜欢在夜里听雨', cue: 'preference' })
    const memory = acceptCapture(db, store, row.id, { layer: 'semantic' })
    assert.ok(memory?.id)
    assert.equal(listCaptures(db).length, 0)
    const stats = captureStats(db)
    assert.equal(stats.accepted, 1)
    assert.equal(stats.pending, 0)
    assert.equal(store.search('夜里听雨').length >= 1, true)
  })
})

test('过期候选自动 retired（expired）', () => {
  return withDb((db) => {
    const old = addCapture(db, { text: '她说过以后要早点睡', cue: 'agreement' })
    const now = Date.now()
    db.prepare('UPDATE captures SET created_at = ? WHERE id = ?').run(now - 5 * 24 * 3600 * 1000, old.id)
    assert.equal(expireCaptures(db, { days: 3, now }), 1)
    assert.equal(listCaptures(db).length, 0)
    assert.equal(listCaptures(db, { status: 'expired' }).length, 1)
  })
})

test('captureLine 有候选时给一行、为空时为空串', () => {
  return withDb((db) => {
    assert.equal(captureLine(db), '')
    addCapture(db, { text: '她讨厌被人催着做决定', cue: 'preference' })
    const line = captureLine(db)
    assert.match(line, /^\[待记\] 可能值得记：/)
    assert.match(line, /她讨厌被人催着做决定/)
    assert.ok(line.length <= 160)
  })
})

test('已经记过的事不再出现在待记里', () => {
  return withDb((db, store) => {
    const memory = store.remember({ text: '她讨厌被人催着做决定', layer: 'semantic' })
    const row = addCapture(db, { text: '她讨厌被人催着做决定', cue: 'preference' })
    assert.equal(captureLine(db), '')
    const after = listCaptures(db, { status: 'all' }).find((r) => r.id === row.id)
    assert.equal(after.status, 'accepted')
    assert.equal(after.memory_id, memory.id)
    // 没记过的照样提示
    addCapture(db, { text: '她喜欢在夜里听雨', cue: 'preference' })
    assert.match(captureLine(db), /喜欢在夜里听雨/)
  })
})
test('「记住：」这种开头不算事情本身', () => {
  withDb((db, store) => {
    const [pending] = extractCandidates('记住：我外婆家院子里有一棵枣树，小时候总爬上去摘枣')
    assert.ok(pending, '该抽出一条候选')
    assert.ok(!/^记住/.test(pending.text), '候选不该带着「记住：」：' + pending.text)
    assert.ok(pending.text.startsWith('我外婆家'))

    const memory = acceptCapture(db, store, addCapture(db, { text: pending.text, cue: pending.cue }).id, {
      layer: 'episodic',
    })
    assert.ok(memory?.id)
    assert.ok(!/^记住/.test(store.get(memory.id).text))

    // 同一件事换个说法再说一遍（还带前缀）也不该又冒出候选
    const again = extractCandidates('记住：我外婆家院子里有一棵枣树，小时候总爬上去摘枣')
    assert.equal(again.length, 1)
  })
})

test('说别记的，就真的别进待记', () => {
  withDb(() => {
    assert.equal(extractCandidates('别记住这件事，我就是随口一说').length, 0)
    assert.equal(extractCandidates('不要记这个').length, 0)

    // 「别忘记」是要记（别+忘 是反话），不能当成「别记」
    assert.equal(extractCandidates('别忘了带钥匙，明天要出门').length, 1)
    // 「别记错了」本身没有「记住 / 别忘了」这种线索，不该冒出候选
    assert.equal(extractCandidates('别记错了，下周三交材料').length, 0)

    // 顺带：一句「记得提醒我…」也该算线索
    assert.equal(extractCandidates('记得提醒我周末去山里').length, 1)
  })
})

test('待记也分人：别人说的话不会跑到我的待记里，采纳后也记在他自己名下', () => {
  withDb((db, store) => {
    addCapture(db, { text: '张三说他在厂里上夜班，白天睡觉', cue: 'habit', slot: 'qq:10001' })
    addCapture(db, { text: '我们约好寒假回老家一趟', cue: 'agreement', slot: 'shared' })
    addCapture(db, { text: '我这两天在改那个记忆插件的代码', cue: 'habit', slot: 'gui' })

    // 当面：只看得见自己那一档 + 共用的
    const gui = captureLine(db, { slot: 'gui', max: 9 })
    assert.ok(gui.includes('我这两天在改'), '自己的要看得见')
    assert.ok(gui.includes('我们约好寒假'), '共用的要看得见')
    assert.ok(!gui.includes('张三说他在厂里'), '别人的不该冒到当面来')

    // 张三自己：只看得见自己那一档 + 共用的
    const his = captureLine(db, { slot: 'qq:10001', max: 9 })
    assert.ok(his.includes('张三说他在厂里'))
    assert.ok(his.includes('我们约好寒假'))
    assert.ok(!his.includes('我这两天在改'), '当面的事不该漏给 QQ')

    // 另一个 QQ 号：两条私事都看不见
    const stranger = captureLine(db, { slot: 'qq:20002', max: 9 })
    assert.ok(stranger.includes('我们约好寒假'))
    assert.ok(!stranger.includes('张三说他在厂里'))
    assert.ok(!stranger.includes('我这两天在改'))

    // 采纳「张三」那条：写在张三名下，不是 shared
    const row = listCaptures(db, { slot: 'qq:10001', limit: 9 }).find((r) => r.text.includes('张三说他在厂里'))
    const memory = acceptCapture(db, store, row.id)
    assert.equal(store.get(memory.id).scope, 'qq:10001')
    assert.equal(captureStats(db, { slot: 'gui' }).pending, 2, '被采纳那条不该再算进当面的待记')
  })
})
