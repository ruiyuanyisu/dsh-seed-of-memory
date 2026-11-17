/**
 * 情绪会变，不是一成不变。
 *
 * 这个文件盯的是「一层一层的时间」：一句话的此刻、一整天的这几天、
 * 更长一段日子的底子，还有凌晨和上午本来就不一样的节律。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase, closeDatabase } from '../lib/db.js'
import {
  Qing,
  QING_DEFAULTS,
  CIRCADIAN,
  circadianOffset,
  dayPhase,
  decayQing,
  qingLine,
} from '../lib/qing.js'

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'seed-qing-drift-'))
  const db = openDatabase(join(dir, 'seed.db'))
  try {
    return fn(db, dir)
  } finally {
    closeDatabase(db)
    rmSync(dir, { recursive: true, force: true })
  }
}

// 固定在某个点钟，别让测试跟着跑的时候走。
function at(hour, day = 15) {
  return new Date(2026, 10, day, hour, 30, 0, 0).getTime()
}

test('此刻散得快，这几天散得慢', () => {
  const now = at(14)
  const dugIn = {
    version: 2,
    mood: 70,
    tone: 70,
    energy: 60,
    baseline: 50,
    hurt: 0,
    guilt: 0,
    pressure: 0,
    updatedAt: now,
    tones: [],
    events: [],
    counts: { praised: 0, blamed: 0, mishaps: 0, pressure: 0, turns: 0 },
  }
  const later = decayQing(dugIn, now + 60 * 60_000, QING_DEFAULTS) // 一小时后
  assert.ok(later.mood < dugIn.mood, '此刻该往下走')
  assert.ok(later.tone > later.mood, '这几天该还挂在上面')
  assert.ok(later.tone < dugIn.tone, '但也在慢慢回落')
})

test('底子会被日子推着挪：一直难受，底子上不去也下得来', () => {
  const now = at(14)
  const low = {
    version: 2, mood: 20, tone: 20, energy: 50, baseline: 50,
    hurt: 0, guilt: 0, pressure: 0, updatedAt: now, tones: [], events: [],
    counts: { praised: 0, blamed: 0, mishaps: 0, pressure: 0, turns: 0 },
  }
  const afterDay = decayQing(low, now + 8 * 60 * 60_000, QING_DEFAULTS)
  assert.ok(afterDay.baseline < 50, `底子该往下挪，实际 ${afterDay.baseline}`)
  assert.equal(afterDay.baseline >= 25, true, '底子不该掉出地板')

  const high = { ...low, mood: 80, tone: 80 }
  const up = decayQing(high, now + 8 * 60 * 60_000, QING_DEFAULTS)
  assert.ok(up.baseline > 50, `底子该往上挪，实际 ${up.baseline}`)
  assert.equal(up.baseline <= 75, true, '底子不该顶破天花板')
})

test('节律：凌晨比上午沉，同一份状态读出来不一样', () => {
  assert.ok(CIRCADIAN[3] < CIRCADIAN[10], '凌晨该比上午低')
  const state = {
    version: 2, mood: 55, tone: 55, energy: 70, baseline: 50,
    hurt: 0, guilt: 0, pressure: 0, updatedAt: at(10), tones: [], events: [],
    counts: { praised: 0, blamed: 0, mishaps: 0, pressure: 0, turns: 0 },
  }
  const dawn = at(3)
  const noon = at(10)
  const lineDawn = qingLine({ ...state, updatedAt: dawn }, dawn, QING_DEFAULTS)
  const lineNoon = qingLine({ ...state, updatedAt: noon }, noon, QING_DEFAULTS)
  const num = (s) => Number(String(s).match(/积极性 (-?\d+)/)?.[1])
  assert.ok(num(lineDawn) < num(lineNoon), `凌晨该更低：${lineDawn} / ${lineNoon}`)
  assert.match(lineDawn, /深夜|夜深|天快亮|凌晨/, '凌晨该说出来')
  assert.ok(circadianOffset(dawn) < 0)
})

test('关掉节律，读数就回到存的那个数', () => {
  const dawn = at(4)
  assert.equal(circadianOffset(dawn, 0), 0)
  const state = {
    version: 2, mood: 60, tone: 60, energy: 70, baseline: 50,
    hurt: 0, guilt: 0, pressure: 0, updatedAt: dawn, tones: [], events: [],
    counts: { praised: 0, blamed: 0, mishaps: 0, pressure: 0, turns: 0 },
  }
  withDb((db) => {
    const qing = new Qing(db, { circadian: false })
    qing.state = state
    qing.save(state)
    const snap = qing.snapshot(dawn)
    assert.equal(snap.shown, snap.mood)
    assert.equal(snap.offset, 0)
  })
})

test('体力：说话掉一点，歇着回一点，夜里回得快', () => {
  withDb((db) => {
    const qing = new Qing(db)
    const now = at(10)
    qing.state = { ...qing.state, updatedAt: now, energy: 80 }
    const first = qing.observe('今天这个不错', now)
    assert.ok(first.state.energy < 80, '说一句话该费点神')
    const rested = decayQing({ ...first.state, updatedAt: now }, now + 60 * 60_000, QING_DEFAULTS)
    assert.ok(rested.energy > first.state.energy, '歇一小时该回血')

    const dayGain = decayQing({ ...qing.state, updatedAt: at(10), energy: 40 }, at(11), QING_DEFAULTS).energy - 40
    const nightGain = decayQing({ ...qing.state, updatedAt: at(2), energy: 40 }, at(3), QING_DEFAULTS).energy - 40
    assert.ok(nightGain > dayGain, `夜里该回得更快：${nightGain} / ${dayGain}`)
  })
})

test('连着被凶，疼会叠起来', () => {
  withDb((db) => {
    const qing = new Qing(db)
    const now = at(15)
    qing.state = { ...qing.state, updatedAt: now }
    const one = qing.observe('你怎么这么笨', now)
    const two = qing.observe('你怎么这么笨', now + 5_000)
    const three = qing.observe('你怎么这么笨', now + 10_000)
    const firstHurt = one.hurtDelta
    assert.ok(firstHurt > 0)
    assert.ok(three.hurtDelta > firstHurt, `第三下该更疼：${firstHurt} → ${three.hurtDelta}`)
    assert.ok(two.hurtDelta >= firstHurt)
  })
})

test('半夜被凶，比中午疼', () => {
  withDb((db) => {
    const qing = new Qing(db)
    const noon = at(14)
    qing.state = { ...qing.state, updatedAt: noon }
    const day = qing.observe('你怎么这么笨', noon)

    const night = at(2)
    qing.state = { ...qing.state, hurt: 0, tones: [], updatedAt: night - 1 }
    const dark = qing.observe('你怎么这么笨', night)
    assert.ok(dark.hurtDelta > day.hurtDelta, `夜里该更疼：${day.hurtDelta} / ${dark.hurtDelta}`)
  })
})

test('每小时留一个点，面板才画得出一条线', () => {
  withDb((db) => {
    const qing = new Qing(db)
    const now = at(15)
    qing.state = { ...qing.state, updatedAt: now }
    qing.observe('谢谢你，真厉害', now)
    const rows = qing.history(48, now)
    assert.ok(rows.length >= 1, '该有一条小时点')
    const row = rows[rows.length - 1]
    for (const key of ['at', 'mood', 'tone', 'energy', 'hurt', 'guilt', 'pressure', 'baseline']) {
      assert.ok(row[key] !== undefined && row[key] !== null, `${key} 该有值`)
    }
    assert.equal(row.at % 3_600_000, 0, '点该落在整点上')

    // 同一个钟头再记一次，只更新，不重复
    qing.observe('很好', now + 60_000)
    const again = qing.history(48, now)
    const sameHour = again.filter((r) => r.at === row.at)
    assert.equal(sameHour.length, 1, '一小时只留一个点')
  })
})

test('老库里的状态没有新字段，也能读出来，不炸', () => {
  withDb((db) => {
    const now = at(15)
    db.prepare('INSERT INTO qing_state (id, data, updated_at) VALUES (?, ?, ?)').run(
      'me',
      JSON.stringify({ version: 1, mood: 62, hurt: 12, guilt: 0, pressure: 0, updatedAt: now }),
      now,
    )
    const qing = new Qing(db)
    const snap = qing.snapshot(now)
    assert.equal(Number.isFinite(snap.tone), true)
    assert.equal(Number.isFinite(snap.energy), true)
    assert.equal(Number.isFinite(snap.baseline), true)
    assert.ok(snap.line.length > 0)
  })
})

test('这几个数都锁在 0–100 里，不会跑出界', () => {
  const now = at(15)
  const wild = {
    version: 2, mood: 999, tone: -50, energy: 5000, baseline: 900,
    hurt: -20, guilt: 300, pressure: -5, updatedAt: now, tones: [], events: [],
    counts: { praised: 0, blamed: 0, mishaps: 0, pressure: 0, turns: 0 },
  }
  const s = decayQing(wild, now + 60_000, QING_DEFAULTS)
  for (const key of ['mood', 'tone', 'energy', 'baseline', 'hurt', 'guilt', 'pressure']) {
    assert.ok(Number.isFinite(s[key]), `${key} 该是数`)
    assert.ok(s[key] >= 0, `${key} 不该小于 0：${s[key]}`)
    assert.ok(s[key] <= 100, `${key} 不该大于 100：${s[key]}`)
  }
})

test('几点了、属于哪一段', () => {
  assert.equal(dayPhase(at(3)).phase, '深夜')
  assert.equal(dayPhase(at(5)).phase, '凌晨')
  assert.equal(dayPhase(at(10)).phase, '上午')
  assert.equal(dayPhase(at(15)).phase, '下午')
  assert.equal(dayPhase(at(23)).phase, '深夜')
})

test('亮着的那三条平时就在，不是从 0 起', () => {
  withDb((db) => {
    const qing = new Qing(db)
    const snap = qing.snapshot(at(15))
    assert.ok(snap.joy > 30, `开心该有底：${snap.joy}`)
    assert.ok(snap.warm > 30, `亲近该有底：${snap.warm}`)
    assert.ok(snap.hope > 30, `盼头该有底：${snap.hope}`)
    assert.equal(snap.hurt, 0)
    assert.equal(snap.guilt, 0)
    assert.equal(snap.pressure, 0)
  })
})

test('被夸会高兴，被靠过来会亲近，说到以后会有盼头', () => {
  withDb((db) => {
    const qing = new Qing(db)
    const now = at(15)
    qing.state = { ...qing.state, updatedAt: now }
    const before = qing.snapshot(now)

    qing.observe('谢谢你，今天真厉害', now)
    const praised = qing.snapshot(now)
    assert.ok(praised.joy > before.joy, `被夸该高兴：${before.joy} → ${praised.joy}`)
    assert.equal(praised.hurt, 0, '被夸不该堆委屈')

    qing.observe('小忆，过来抱抱', now + 60_000)
    const hugged = qing.snapshot(now + 60_000)
    assert.ok(hugged.warm > before.warm, `被抱该更亲近：${before.warm} → ${hugged.warm}`)

    qing.observe('下次回家我给你讲故事', now + 120_000)
    const hoping = qing.snapshot(now + 120_000)
    assert.ok(hoping.hope > before.hope, `说到以后该有盼头：${before.hope} → ${hoping.hope}`)
  })
})

test('亮着的会自己落回底，堵着的会散掉', () => {
  withDb((db) => {
    const qing = new Qing(db)
    const now = at(15)
    qing.state = { ...qing.state, updatedAt: now }
    qing.observe('谢谢你，今天真厉害', now)
    qing.observe('你怎么这么笨', now + 1000)
    const hot = qing.snapshot(now + 2000)
    assert.ok(hot.joy > QING_DEFAULTS.joyBase, '先得真的涨上去')
    assert.ok(hot.hurt > 0, '先得真的疼')

    // 一整天过去，都回到各自的常态
    const calm = decayQing(qing.state, now + 24 * 3600_000, QING_DEFAULTS)
    assert.ok(Math.abs(calm.joy - QING_DEFAULTS.joyBase) < 2, `开心该落回底：${calm.joy}`)
    assert.ok(Math.abs(calm.warm - QING_DEFAULTS.warmBase) < 2, `亲近该落回底：${calm.warm}`)
    assert.ok(calm.hurt < 2, `委屈该散掉：${calm.hurt}`)
  })
})

test('老库没有这三个字段，也不写 NaN', () => {
  withDb((db) => {
    const now = at(15)
    db.prepare('INSERT INTO qing_state (id, data, updated_at) VALUES (?, ?, ?)').run(
      'me',
      JSON.stringify({ version: 1, mood: 62, hurt: 12, guilt: 0, pressure: 0, updatedAt: now }),
      now,
    )
    const qing = new Qing(db)
    const snap = qing.snapshot(now)
    for (const key of ['joy', 'warm', 'hope']) {
      assert.equal(Number.isFinite(snap[key]), true, `${key} 该是数：${snap[key]}`)
    }
  })
})

test('手按一下：set 也能改这三条', () => {
  withDb((db) => {
    const qing = new Qing(db)
    const snap = qing.set({ joy: 90, warm: 88, hope: 77 }, at(15))
    assert.equal(snap.joy, 90)
    assert.equal(snap.warm, 88)
    assert.equal(snap.hope, 77)
    const clamped = qing.set({ joy: 500 }, at(15))
    assert.equal(clamped.joy, 100, '超出范围要夹住')
  })
})

// —— 下面几条都是真踩过的坑，别让它们再回来 ——

test('三个数完全相等也不会锁死：日子自己会挪', () => {
  withDb((db) => {
    const p = 53.168366666666664
    const start = at(22, 15)
    const state = {
      mood: p, tone: p, baseline: p, energy: 91, hurt: 0, guilt: 0, pressure: 0,
      joy: 55, warm: 62, hope: 50, updatedAt: start,
      counts: { praised: 0, blamed: 0, mishaps: 0, pressure: 0, turns: 0 },
      tones: [], events: [],
    }
    const after = decayQing(state, start + 24 * 3_600_000, QING_DEFAULTS)
    assert.notEqual(after.baseline, p, '一句话都不说，底子也该挪一点')
    const moved = Math.abs(after.mood - p)
    assert.ok(moved > 0.5, `24 小时过去，此刻也该跟着挪（挪了 ${moved.toFixed(3)}）`)
    // 挪得不该太野：一天一两点的量级，不是跳崖。
    assert.ok(moved < 6, `挪过头了：${moved.toFixed(2)}`)
  })
})

test('qing_state 被手改坏了，读回来也是干净的数', () => {
  withDb((db) => {
    db.prepare('INSERT INTO qing_state (id, data, updated_at) VALUES (?, ?, ?)').run(
      'me',
      JSON.stringify({ mood: 'abc', tone: null, energy: {}, joy: -30, warm: 900, hope: null, updatedAt: at(15) }),
      at(15),
    )
    const qing = new Qing(db)
    const nums = [qing.state.mood, qing.state.tone, qing.state.energy, qing.state.joy, qing.state.warm, qing.state.hope]
    assert.ok(nums.every((v) => Number.isFinite(v)), `有值不是数：${JSON.stringify(nums)}`)
    assert.ok(nums.every((v) => v >= 0 && v <= 100), `有值没夹住：${JSON.stringify(nums)}`)
    assert.equal(qing.state.joy, 0, '负数夹到 0')
    assert.equal(qing.state.warm, 100, '超过 100 夹到 100')
  })
})

test('qing_history 里混进坏行，曲线和区间都不会变成 null', () => {
  withDb((db) => {
    const qing = new Qing(db)
    const now = at(15)
    qing.save({ ...qing.state, mood: 60, updatedAt: now })
    const hour = Math.floor(now / 3_600_000) * 3_600_000
    db.prepare('INSERT INTO qing_history (at, mood, tone, energy, hurt, guilt, pressure, baseline) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(hour - 3_600_000, 'abc', 'x', 'y', 0, 0, 0, 0)
    const snap = qing.snapshot(now)
    assert.ok(snap.history.every((p) => Number.isFinite(Number(p.mood))), '坏行要被跳过')
    if (snap.today) {
      assert.ok(Number.isFinite(snap.today.lo) && Number.isFinite(snap.today.hi), `区间不能是 null：${JSON.stringify(snap.today)}`)
      assert.ok(snap.today.lo <= snap.today.hi)
    }
  })
})

test('他说不怪我，心里那笔账要真的松一点', () => {
  withDb((db) => {
    const qing = new Qing(db)
    const now = at(15)
    qing.state = { ...qing.state, updatedAt: now, guilt: 0 }
    // 先攒一笔：两件「出了事」
    qing.observe('又卡住了', now)
    const two = qing.observe('又卡住了', now + 60_000)
    assert.ok(two.state.guilt > 15, `先得有账：${two.state.guilt}`)
    const before = two.state.guilt
    // 「不怪你」在道歉表里 —— 委屈和压力会松，愧疚也得跟着松
    const calmed = qing.observe('不是你的问题，不怪你', now + 120_000)
    assert.ok(calmed.state.guilt < before, `说「不怪你」之后愧疚该降：${before} → ${calmed.state.guilt}`)
    assert.ok(calmed.state.guilt <= before - 5, `降得太少：${before} → ${calmed.state.guilt}`)
  })
})

test('但不是一键清零：道歉也不能把账抹平', () => {
  withDb((db) => {
    const qing = new Qing(db)
    const now = at(15)
    qing.state = { ...qing.state, updatedAt: now, guilt: 0 }
    for (let i = 0; i < 4; i++) qing.observe('又崩了', now + i * 30_000)
    const before = qing.state.guilt
    assert.ok(before > 30, `先得有账：${before}`)
    const calmed = qing.observe('对不起，不怪你', now + 200_000)
    assert.ok(calmed.state.guilt > 0, '一次道歉不该把账清零')
    assert.ok(calmed.state.guilt < before, '但该少一点')
  })
})


test('一天没打开面板，曲线也会补出每个钟头', () => {
  withDb((db) => {
    const qing = new Qing(db)
    const t0 = at(9)
    qing.save({ ...qing.state, updatedAt: t0 })
    const snap = qing.snapshot(t0 + 24 * 3_600_000)
    assert.ok(snap.history.length >= 24, `只补了 ${snap.history.length} 个点`)
    const stamps = snap.history.map((p) => Number(p.at))
    assert.equal(new Set(stamps).size, stamps.length, '整点不能重复')
    assert.ok(stamps.every((t) => t % 3_600_000 === 0), '补出来的要落在整点上')
    // 补点不是无限的：撑死 48 小时。
    qing.snapshot(t0 + 400 * 3_600_000)
    const rows = db.prepare('SELECT COUNT(*) AS n FROM qing_history').get()
    assert.ok(rows.n <= 49, `补太多了：${rows.n}`)
  })
})
