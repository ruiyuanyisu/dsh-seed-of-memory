import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase, closeDatabase } from '../lib/db.js'
import { Qing, scoreText, decayQing, qingLine } from '../lib/qing.js'

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'seed-qing-'))
  const db = openDatabase(join(dir, 'seed.db'))
  try {
    return fn(db, dir)
  } finally {
    closeDatabase(db)
    rmSync(dir, { recursive: true, force: true })
  }
}

test('夸：认得出好话，心情往上走', () => {
  const scored = scoreText('谢谢你，真厉害')
  assert.ok(scored.praised.length >= 2, `没认出夸的词：${scored.praised.join('/')}`)
  assert.equal(scored.tone, 'praise')
  assert.ok(scored.delta > 0)
})

test('否定：一点都不厉害不算夸', () => {
  const scored = scoreText('一点都不厉害')
  assert.equal(scored.praised.length, 0)
})

test('重话：骂人的话往下掉，记委屈', () => {
  const scored = scoreText('你真是个垃圾')
  assert.ok(scored.blamed.includes('垃圾'))
  assert.equal(scored.tone, 'blame')
  assert.ok(scored.delta < 0)
})

test('技术词不算骂：可回滚、回滚到上一版都不该扣分', () => {
  for (const line of ['只做可回滚、有测试覆盖的小改动', '先回滚到上一版再说']) {
    const scored = scoreText(line)
    assert.deepEqual(scored.blamed, [], line)
    assert.equal(scored.tone, 'neutral', line)
  }
  // 单独一个「滚」还是骂
  assert.deepEqual(scoreText('滚').blamed, ['滚'])
})

test('整句只有一个感叹词的，不算骂人', () => {
  for (const line of ['卧槽', '我操', '靠', '妈的', '卧槽 ']) {
    const scored = scoreText(line)
    assert.deepEqual(scored.blamed, [], line)
    assert.equal(scored.delta, 0, line)
  }
  // 带着骂人的话时照算
  assert.deepEqual([...scoreText('卧槽你个废物').blamed].sort(), ['废物', '卧槽'].sort())
})

test('反话：呵呵真棒不夸', () => {  const scored = scoreText('呵呵，真厉害')
  assert.equal(scored.sarcastic, true)
  assert.equal(scored.praised.length, 0)
})

test('出事：出问题记愧疚，心情不因为「出事」被骂而掉', () => {
  const scored = scoreText('完蛋了，又报错')
  assert.ok(scored.mishaps.length >= 1)
  assert.equal(scored.tone, 'mishap')
  assert.ok(scored.guiltDelta > 0)
})

test('急：快点 / 来不及算压力', () => {
  const scored = scoreText('快点，来不及了')
  assert.ok(scored.pressured.length >= 2)
  assert.equal(scored.tone, 'pressure')
  assert.ok(scored.pressureDelta > 0)
})

test('平常话：不夸不骂不打分', () => {
  const scored = scoreText('今天几号')
  assert.equal(scored.tone, 'neutral')
  assert.equal(scored.delta, 0)
})

test('存下来：换个实例读得到', () => {
  withDb((db) => {
    const qing = new Qing(db)
    qing.observe('你真厉害')
    const again = new Qing(db)
    assert.ok(again.snapshot().mood > 50)
    assert.equal(again.snapshot().counts.praised, 1)
  })
})

test('连着夸：第三句多给三成；连着骂：第三句只算六成', () => {
  withDb((db) => {
    const qing = new Qing(db)
    qing.observe('真厉害')
    assert.equal(qing.observe('太给力了').factor, 1)
    assert.equal(qing.observe('挺靠谱的').factor, 1.3)

    const other = new Qing(db)
    other.set({ level: 80 })
    other.observe('你是垃圾')
    assert.equal(other.observe('真是个废物').factor, 1)
    assert.equal(other.observe('蠢东西').factor, 0.6)
  })
})

test('时间会冲淡：各维度按各自速率回常态', () => {
  const now = Date.now()
  const state = { mood: 20, hurt: 40, guilt: 10, pressure: 30, updatedAt: now - 600_000 }
  const out = decayQing(state, now, {
    decayPerMin: 0.5,
    hurtDecayPerMin: 0.35,
    guiltDecayPerMin: 0.45,
    pressureDecayPerMin: 1.6,
  })
  assert.ok(Math.abs(out.mood - 25) < 1e-6, `mood=${out.mood}`)
  assert.ok(Math.abs(out.hurt - 36.5) < 1e-6, `hurt=${out.hurt}`)
  assert.ok(Math.abs(out.guilt - 5.5) < 1e-6, `guilt=${out.guilt}`)
  assert.ok(Math.abs(out.pressure - 14) < 1e-6, `pressure=${out.pressure}`)
})

test('一行话：只报状态，不教怎么演', () => {
  const now = Date.now()
  const happy = qingLine({ mood: 90, hurt: 0, guilt: 0, pressure: 0, updatedAt: now, events: [] }, now)
  assert.match(happy, /心里松快/)
  assert.match(happy, /积极性 90/)

  const calm = qingLine({ mood: 50, hurt: 0, guilt: 0, pressure: 0, updatedAt: now, events: [] }, now)
  assert.match(calm, /平稳/)

  const flat = qingLine({ mood: 15, hurt: 0, guilt: 0, pressure: 0, updatedAt: now, events: [] }, now)
  assert.match(flat, /话少/)

  const hurt = qingLine({ mood: 40, hurt: 60, guilt: 0, pressure: 0, updatedAt: now, events: [] }, now)
  assert.match(hurt, /委屈还压着 60/)

  const quiet = qingLine({ mood: 40, hurt: 0, guilt: 0, pressure: 40, updatedAt: now, events: [] }, now)
  assert.match(quiet, /他那边急/)
})

test('手动改：超范围的数会被夹回 0–100', () => {
  withDb((db) => {
    const qing = new Qing(db)
    assert.equal(qing.set({ level: 120 }).mood, 100)
    assert.equal(qing.set({ level: 50, delta: -500 }).mood, 0)
    const snap = qing.set({ hurt: 30, guilt: 10, pressure: 20 })
    assert.equal(snap.hurt, 30)
    assert.equal(snap.guilt, 10)
    assert.equal(snap.pressure, 20)
  })
})

test('手动擦一下：最近那一下能清掉，数字还在', () => {
  withDb((db) => {
    const qing = new Qing(db)
    qing.observe('你真是个垃圾')
    const dirty = qing.snapshot()
    assert.ok(dirty.recent.length > 0, '应当有一条事件')
    const cleared = qing.set({ level: 50, hurt: 0, clear: true })
    assert.equal(cleared.mood, 50)
    assert.equal(cleared.hurt, 0)
    assert.equal(cleared.recent.length, 0)
    assert.equal(cleared.counts.blamed, 0)
    assert.equal(cleared.counts.turns, 0)
  })
})

test('同一个词不数两遍：长词盖住短词，重复命中只算一次', () => {
  const scored = scoreText('一般般')
  assert.deepEqual(scored.softed, ['一般般'], `softed=${scored.softed.join('/')}`)
  const twice = scoreText('搞砸了搞砸了')
  assert.equal(twice.mishaps.filter((w) => w === '搞砸').length, 1)
})

test('他道歉：委屈和压力松一点，心情往上走', () => {
  withDb((db) => {
    const qing = new Qing(db)
    qing.observe('你真是个垃圾')
    qing.observe('快点，来不及了')
    const before = qing.snapshot()
    assert.ok(before.hurt > 0, `hurt=${before.hurt}`)
    assert.ok(before.pressure > 0, `pressure=${before.pressure}`)

    const calm = qing.observe('对不起，我太急了')
    assert.ok(calm.calmHurt > 0)
    assert.ok(calm.calmPressure > 0)
    const after = qing.snapshot()
    assert.ok(after.hurt < before.hurt, `${before.hurt} → ${after.hurt}`)
    assert.ok(after.pressure < before.pressure, `${before.pressure} → ${after.pressure}`)
    assert.ok(after.mood >= before.mood)
  })
})

test('同一件事连着来：事件只留一条，不同的事各留一条', () => {
  withDb((db) => {
    const qing = new Qing(db)
    qing.observe('快点')
    qing.observe('快点')
    assert.equal(qing.snapshot().recent.length, 1)

    qing.observe('搞砸了，报错')
    assert.equal(qing.snapshot().recent.length, 2)
  })
})

test('夹在里面的英文也认，但不认半个词：thanks 算夸，goodbye 不算', () => {
  const praise = scoreText('thanks, great work')
  assert.ok(praise.praised.includes('thanks'))
  assert.ok(praise.praised.includes('great'))
  assert.equal(praise.tone, 'praise')

  assert.equal(scoreText('goodbye').praised.length, 0)
  assert.ok(scoreText('this is useless').blamed.includes('useless'))
  assert.equal(scoreText('please hurry').tone, 'pressure')
})

test('QQ 接话：只看刚发来的那句，不把「刚才」再算一遍', () => {
  const scored = scoreText('[刚才] 老大：滚\n你：好\n（下面是老大刚发来的）\n谢谢你')
  assert.deepEqual(scored.blamed, [])
  assert.ok(scored.praised.includes('谢谢'))
  assert.equal(scored.tone, 'praise')
})

test('起点跟基线走：把基线设成 70，一上来就是 70', () => {
  withDb((db) => {
    const qing = new Qing(db, { baseline: 70 })
    assert.equal(qing.snapshot().mood, 70)
  })
})

test('骂得狠的那一下会顺手记一条情绪，平常话不会', () => {
  withDb((db) => {
    const qing = new Qing(db)
    const heavy = qing.observe('垃圾废物，没用的东西')
    assert.ok(heavy.emotion, '大情绪没记下来')
    const quiet = qing.observe('嗯')
    assert.equal(quiet.emotion, null)
  })
})

test('否定和反问别算反了：「我不觉得你厉害」不是夸，「你是不是傻」是骂', () => {
  assert.deepEqual(scoreText('我不觉得你厉害').praised, [])
  assert.ok(scoreText('不错，你真厉害').praised.includes('厉害'))
  assert.ok(scoreText('不得不说你真厉害').praised.includes('厉害'))
  assert.deepEqual(scoreText('你不笨').blamed, [])
  assert.ok(scoreText('你是不是傻').blamed.includes('傻'))
})

test('抱一下、说晚安是「靠过来」，不是挑毛病', () => {
  const warm = scoreText('抱抱我，晚安')
  assert.equal(warm.tone, 'warm')
  assert.deepEqual(warm.softed, [])
  assert.ok(warm.warmed.includes('抱抱'))
  assert.ok(warm.delta > 0, `delta=${warm.delta}`)

  const miss = scoreText('我想你了')
  assert.equal(miss.tone, 'warm')
  assert.ok(miss.delta > 0)
})

test('累了困了不奖也不罚', () => {
  for (const text of ['累死我了', '好累，想睡了', '困了']) {
    const scored = scoreText(text)
    assert.equal(scored.tone, 'neutral', `${text} → ${scored.tone}`)
    assert.equal(scored.delta, 0, `${text} → ${scored.delta}`)
  }
})

test('靠过来的时候，最近那一下写的是「靠过来：…」', () => {
  withDb((db) => {
    const qing = new Qing(db)
    const result = qing.observe('抱抱，晚安')
    assert.equal(result.tone, 'warm')
    assert.match(result.note, /^靠过来：/)
  })
})

test('歌名里的「摇滚」、想办法时的「换个」「再不行」都不算挑毛病', () => {
  assert.deepEqual(scoreText('他喜欢摇滚').blamed, [])
  assert.deepEqual(scoreText('滚').blamed, ['滚'])

  for (const line of ['换个思路', '换个办法', '这招再不行就问一句']) {
    const scored = scoreText(line)
    assert.deepEqual(scored.softed, [], line)
    assert.equal(scored.tone, 'neutral', `${line} → ${scored.tone}`)
  }
  // 真挑毛病的时候还得算
  assert.ok(scoreText('你不行').softed.includes('不行'))
  assert.ok(scoreText('这个不行').softed.includes('不行'))
})

test('找 bug 不等于挑毛病', () => {
  for (const line of ['看看有没有bug', '再测几轮看看有没有 bug', '有没有bug呀']) {
    const scored = scoreText(line)
    assert.deepEqual(scored.softed, [], line)
    assert.equal(scored.delta, 0, line)
  }
  // 真的在说「你这有 bug」还得算
  assert.ok(scoreText('你这个有bug').softed.includes('有bug'))
})

test('他说「我喜欢摇滚」不是在夸我，「我喜欢你」才是', () => {
  for (const line of ['我喜欢摇滚', '我喜欢夜里听雨']) {
    const scored = scoreText(line)
    assert.deepEqual(scored.praised, [], line)
    assert.equal(scored.delta, 0, line)
  }
  const toMe = scoreText('我喜欢你')
  assert.ok(toMe.praised.includes('喜欢你'))
  assert.ok(toMe.delta > 0)
})

test('出事的时候只说心里堵，不乱下「是自己弄坏的」这种结论', () => {
  withDb((db) => {
    const qing = new Qing(db)
    for (let i = 0; i < 6; i++) qing.observe('又卡住了，打不开')
    const snap = qing.snapshot()
    assert.ok(snap.guilt > 0, `guilt=${snap.guilt}`)
    const line = qing.line()
    assert.ok(!line.includes('弄坏'), line)
    assert.match(line, /心里还堵着|委屈|出了事/)
  })
})
