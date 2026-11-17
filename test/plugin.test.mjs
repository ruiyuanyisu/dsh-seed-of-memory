import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { SeedStore } from '../lib/store.js'

// 临时 home 改放项目内，且进程退出时兜底删掉。
// 以前用 os.tmpdir() 又从不清理：一个 home 会带 126MB 的 embedding 运行时，
// 跑几遍测试 C 盘就被塞满（2026-11-15 清出 331 个、40GB）。
const TMP_ROOT = join(import.meta.dirname, '..', '.tmp')
const HOMES = []
let hooked = false
function trackHome(home) {
  HOMES.push(home)
  if (hooked) return
  hooked = true
  process.on('exit', () => {
    for (const dir of HOMES) {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch {}
    }
  })
}

function makeEnv() {
  mkdirSync(TMP_ROOT, { recursive: true })
  const home = mkdtempSync(join(TMP_ROOT, 'home-'))
  trackHome(home)
  process.env.DSH_HOME = home

  const tools = []
  const commands = []
  const prompts = []
  const disposers = []
  const inboxHandlers = []

  const agent = {
    session: { id: 'session-gui-1' },
    ctx: {
      systemPrompt: {
        context(options) {
          prompts.push(options)
          const dispose = () => {}
          disposers.push(dispose)
          return dispose
        },
      },
      on(event, handler) {
        if (event !== 'agent/inbox/inserted') return () => {}
        inboxHandlers.push(handler)
        return () => {
          const at = inboxHandlers.indexOf(handler)
          if (at >= 0) inboxHandlers.splice(at, 1)
        }
      },
    },
  }

  const emitInbox = (text, source) => {
    const message = { content: [{ type: 'text', text }], ...(source ? { source } : {}) }
    for (const handler of inboxHandlers) handler({ message })
  }

  let onDispose = null
  const routes = []

  const services = {
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }

  const ctx = {
    inject(names, callback) {
      const picked = {}
      for (const name of names) picked[name] = services[name]
      return callback(picked)
    },
    on(event, handler) {
      if (event === 'dispose') onDispose = handler
    },
    agents: { list: () => [agent] },
  }

  const cleanup = () => {
    try { onDispose?.() } catch {}
    try { rmSync(home, { recursive: true, force: true, maxRetries: 3 }) } catch {}
  }
  return { home, ctx, tools, commands, prompts, disposers, inbox: inboxHandlers, routes, cleanup, emitInbox }
}

test('registers the seed tools with valid schema', () => {
  const env = makeEnv()
  try {
    apply(env.ctx, { budget: 600 })
    const names = env.tools.map((t) => t.name).sort()
    assert.deepEqual(names, [
      'seed_anchor',
      'seed_aspire',
      'seed_believe',
      'seed_compat',
      'seed_consolidate',
      'seed_contact',
      'seed_feel',
      'seed_forget',
      'seed_habit',
      'seed_inspect',
      'seed_loose',
      'seed_open',
      'seed_qing',
      'seed_remember',
      'seed_search',
      'seed_trait',
    ])
    for (const definition of env.tools) {
      assert.equal(definition.parameters.type, 'object')
      const required = definition.parameters.required ?? []
      for (const key of required) {
        assert.ok(definition.parameters.properties[key], `${definition.name} missing property ${key}`)
      }
      assert.equal(typeof definition.output.render, 'function')
      const blocks = definition.output.render({}, { text: 'hello' })
      assert.equal(blocks[0].type, 'text')
      assert.equal(blocks[0].text, 'hello')
    }
  } finally {
    env.cleanup()
  }
})

test('remember, search, why and forget work end to end', async () => {
  const env = makeEnv()
  try {
    apply(env.ctx, { budget: 600 })
    const byName = Object.fromEntries(env.tools.map((t) => [t.name, t]))
    const wrote = await byName.seed_remember.execute({ text: '她喜欢夜里听雨', layer: 'semantic', factKey: '她.偏好.雨' })
    assert.match(wrote.text, /已记住/)

    const found = await byName.seed_search.execute({ q: '听雨' })
    assert.match(found.text, /夜里听雨/)

    const id = wrote.text.match(/(m_[a-z0-9]+)$/)[1]
    const why = await byName.seed_inspect.execute({ what: 'why', id })
    assert.match(why.text, /她喜欢夜里听雨/)

    const removed = await byName.seed_forget.execute({ id })
    assert.match(removed.text, /已删除/)
  } finally {
    env.cleanup()
  }
})

test('mounts a memory card into the agent system prompt', async () => {
  const env = makeEnv()
  try {
    apply(env.ctx, { budget: 600 })
    const byName = Object.fromEntries(env.tools.map((t) => [t.name, t]))
    await byName.seed_remember.execute({ text: '她名字里有个雨字', layer: 'persona' })

    assert.equal(env.prompts.length, 1)
    const options = env.prompts[0]
    assert.equal(options.name, 'seed-of-memory')
    assert.equal(options.interpolate, false)
    const text = options.text()
    assert.match(text, /不是本轮指令/)
    assert.match(text, /雨/)
    // the identity root must be present before the memory card, in every session
    assert.match(text, /Seed of Memory · 根/)
    assert.match(text, /我是谁/)
  } finally {
    env.cleanup()
  }
})

test('auto-captures a cued sentence and clears it after remember', async () => {
  const env = makeEnv()
  try {
    apply(env.ctx, { budget: 600 })
    // wait one sweep so the card is mounted and the inbox listener attached
    await new Promise((resolve) => setTimeout(resolve, 20))
    env.emitInbox('今天有点累。记住：我讨厌被人催着做决定。')
    const options = env.prompts[0]
    const text = options.text()
    assert.match(text, /\[待记\]/)
    assert.match(text, /我讨厌被人催着做决定/)

    const byName = Object.fromEntries(env.tools.map((t) => [t.name, t]))
    await byName.seed_remember.execute({ text: '我讨厌被人催着做决定', layer: 'semantic' })
    assert.doesNotMatch(options.text(), /\[待记\]/)
  } finally {
    env.cleanup()
  }
})

test('收件箱里的一句话会进情绪内核（不用模型自己动手）', async () => {
  const env = makeEnv()
  try {
    apply(env.ctx, { budget: 600 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    env.emitInbox('谢谢你，今天真厉害')

    const byName = Object.fromEntries(env.tools.map((t) => [t.name, t]))
    const status = await byName.seed_qing.execute({ action: 'status' })
    assert.match(status.text, /此刻 72/)
    assert.match(status.text, /被夸 1/)

    // 卡片上也应该跟着说了
    assert.match(env.prompts[0].text(), /\[情绪\]/)
  } finally {
    env.cleanup()
  }
})

test('情绪内核关了就不记、卡片上也不写', async () => {
  const env = makeEnv()
  try {
    apply(env.ctx, { budget: 600, emotion: false })
    await new Promise((resolve) => setTimeout(resolve, 20))
    env.emitInbox('谢谢你，今天真厉害')

    const byName = Object.fromEntries(env.tools.map((t) => [t.name, t]))
    const status = await byName.seed_qing.execute({ action: 'status' })
    assert.match(status.text, /此刻 50/)
    assert.match(status.text, /被夸 0/)
    assert.match(status.text, /情绪内核已关/)
    assert.doesNotMatch(env.prompts[0].text(), /\[情绪\]/)

    const mood = await env.commands[0].execute('mood')
    assert.match(mood.text, /情绪（已关）/)
  } finally {
    env.cleanup()
  }
})

test('系统消息不进情绪账：goal round 的「可回滚」不算骂', async () => {
  const env = makeEnv()
  try {
    apply(env.ctx, { budget: 600 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const byName = Object.fromEntries(env.tools.map((t) => [t.name, t]))

    env.emitInbox('Objective: 只做可回滚、有测试覆盖的小改动。', { kind: 'goal', round: 1 })
    const quiet = await byName.seed_qing.execute({ action: 'status' })
    assert.match(quiet.text, /此刻 50/)
    assert.match(quiet.text, /被说重话 0/)

    // 他真说的话照算，但「回滚」也不算骂
    env.emitInbox('可回滚、有测试覆盖，你随便改')
    const rollback = await byName.seed_qing.execute({ action: 'status' })
    assert.match(rollback.text, /被说重话 0/)

    env.emitInbox('滚')
    const blamed = await byName.seed_qing.execute({ action: 'status' })
    assert.match(blamed.text, /被说重话 1/)
  } finally {
    env.cleanup()
  }
})

test('/seed mood 也带情绪四维和最近那一下', async () => {
  const env = makeEnv()
  try {
    apply(env.ctx, { budget: 600 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    env.emitInbox('你真是个垃圾')
    const out = await env.commands[0].execute('mood')
    assert.match(out.text, /此刻：/)
    assert.match(out.text, /情绪：/)
    assert.match(out.text, /委屈/)
    assert.match(out.text, /最近那一下：被说：垃圾/)
  assert.equal((out.text.match(/最近那一下/g) ?? []).length, 1, '最近那一下 不该出现两遍')
  } finally {
    env.cleanup()
  }
})

test('seed_inspect mood 和 seed_qing test 都能用', async () => {
  const env = makeEnv()
  try {
    apply(env.ctx, { budget: 600 })
    const byName = Object.fromEntries(env.tools.map((t) => [t.name, t]))

    const mood = await byName.seed_inspect.execute({ what: 'mood' })
    assert.match(mood.text, /当下：积极性/)

    const test1 = await byName.seed_qing.execute({ action: 'test', text: '谢谢你，真厉害' })
    assert.match(test1.text, /判定：被夸/)
    assert.match(test1.text, /心情 \+\d+/)

    const warm = await byName.seed_qing.execute({ action: 'test', text: '抱抱，晚安' })
    assert.match(warm.text, /判定：靠过来/)
    assert.match(warm.text, /靠过来：/)
  } finally {
    env.cleanup()
  }
})

test('装了阴晴就不重复注入情绪行，但打分照常记', async () => {
  const env = makeEnv()
  try {
    mkdirSync(join(env.home, 'mood'), { recursive: true })
    writeFileSync(join(env.home, 'mood', 'state.json'), '{"mood":60}')
    apply(env.ctx, { budget: 600 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    env.emitInbox('谢谢你，真厉害')

    assert.doesNotMatch(env.prompts[0].text(), /\[情绪\]/)
    const byName = Object.fromEntries(env.tools.map((t) => [t.name, t]))
    const status = await byName.seed_qing.execute({ action: 'status' })
    assert.match(status.text, /被夸 1/)
  } finally {
    env.cleanup()
  }
})

test('registers the /seed command', () => {
  const env = makeEnv()
  try {
    apply(env.ctx, { budget: 600 })
    assert.equal(env.commands.length, 1)
    assert.equal(env.commands[0].name, 'seed')
  } finally {
    env.cleanup()
  }
})

test('/seed backup 当场存一份，并说得出有几份', async () => {
  const env = makeEnv()
  try {
    apply(env.ctx, { budget: 600 })
    // 插件起来时就顺手存了当天的，所以这里应该是「已经存过了」
    const first = await env.commands[0].execute('backup')
    assert.match(first.text, /今天已经存过了|刚存了一份/)
    assert.match(first.text, /现有 1 份/)
    assert.match(first.text, /seed\.db-backup-\d{4}-\d{2}-\d{2}/)

    const second = await env.commands[0].execute('backup')
    assert.match(second.text, /今天已经存过了/)
    assert.match(second.text, /现有 1 份/)
  } finally {
    env.cleanup()
  }
})

test('README 里的工具数和工具名跟代码一致', async () => {
  const root = new URL('../', import.meta.url)
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('lib/index.js', root), 'utf8')
  const names = [...new Set([...source.matchAll(/tool\(\s*'?(?:[^']*)'?,?\s*'?(seed_[a-z]+)'?/g)].map((m) => m[1]))]
  const readme = readFileSync(new URL('README.md', root), 'utf8')
  assert.match(readme, new RegExp(`工具（${names.length} 个）`))
  for (const name of names) {
    assert.ok(readme.includes(`\`${name}\``), `README 少了 ${name}`)
  }
})

test('关掉插件之后不再偷偷听收件箱（重载不会双记）', async () => {
  const env = makeEnv()
  try {
    apply(env.ctx, { budget: 600 })
    assert.equal(env.inbox.length, 1)
    env.cleanup()
    assert.equal(env.inbox.length, 0, 'dispose 之后监听应该摘干净')
  } finally {
    env.cleanup()
  }
})

test('/seed status 顺手报一下备份有几份', async () => {
  const env = makeEnv()
  try {
    apply(env.ctx, { budget: 600 })
    const out = await env.commands[0].execute('status')
    assert.match(out.text, /记忆之种：共 \d+ 条/)
    assert.match(out.text, /备份 1 份，最近 seed\.db-backup-/)
  } finally {
    env.cleanup()
  }
})

test('/seed anchor 和 /seed grow 真的写得进去（以前会自己撞自己）', async () => {
  const env = makeEnv()
  const { readFileSync } = await import('node:fs')
  try {
    apply(env.ctx, { budget: 600 })
    const seed = env.commands[0]

    const anchored = await seed.execute('anchor 今晚十一点前睡')
    assert.match(anchored.text, /已写进「我们之间」/)
    assert.match(readFileSync(join(env.home, 'seed-of-memory', 'us.md'), 'utf8'), /今晚十一点前睡/)
    const again = await seed.execute('anchor 今晚十一点前睡')
    assert.match(again.text, /这句已经有了/)

    const grown = await seed.execute('grow 我想有点自己的时间')
    assert.match(grown.text, /已写进「我是谁」/)
    assert.match(readFileSync(join(env.home, 'seed-of-memory', 'self.md'), 'utf8'), /我想有点自己的时间/)

    // 空参数给用法，不该抛错
    assert.match((await seed.execute('anchor')).text, /用法：\/seed anchor/)
    assert.match((await seed.execute('grow')).text, /用法：\/seed grow/)
    assert.match((await seed.execute('remember')).text, /用法：\/seed remember/)
    assert.match((await seed.execute('why')).text, /用法：\/seed why/)
  } finally {
    env.cleanup()
  }
})

test('seed_forget 空 id 不能误删（空前缀会 startsWith 命中任何一条）', async () => {
  const env = makeEnv()
  try {
    apply(env.ctx, { budget: 600 })
    const byName = Object.fromEntries(env.tools.map((t) => [t.name, t]))
    await byName.seed_remember.execute({ text: '第一条要被保护的话', layer: 'semantic' })
    await byName.seed_remember.execute({ text: '第二条要被保护的话', layer: 'semantic' })

    for (const id of ['', '   ', 'm']) {
      const out = await byName.seed_forget.execute({ id })
      assert.doesNotMatch(out.text, /已删除/, `空/过短 id ${JSON.stringify(id)} 不该删东西`)
    }
    const stats = await env.commands[0].execute('status')
    assert.match(stats.text, /共 2 条/)
  } finally {
    env.cleanup()
  }
})

test('同一毫秒写的两条，id 前缀对上多条时不许闷头删', async () => {
  const env = makeEnv()
  try {
    apply(env.ctx, { budget: 600 })
    const byName = Object.fromEntries(env.tools.map((t) => [t.name, t]))
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(env.home, 'seed-of-memory', 'seed.db'))
    const store = new SeedStore(db)
    const fixed = 1794574000000
    const a = store.remember({ text: '把这条留下（甲）', layer: 'semantic', now: fixed })
    const b = store.remember({ text: '把这条也留下（乙）', layer: 'semantic', now: fixed })
    assert.notEqual(a.id, b.id)
    let common = 0
    while (common < a.id.length && a.id[common] === b.id[common]) common += 1
    assert.ok(common >= 4, `两条 id 至少要有 4 个共同字符才能测出歧义：${a.id} / ${b.id}`)
    const prefix = a.id.slice(0, common)

    const refused = await byName.seed_forget.execute({ id: prefix })
    assert.match(refused.text, /对上 2 条/)
    assert.match(refused.text, /先说清/)
    const stats = await env.commands[0].execute('status')
    assert.match(stats.text, /共 2 条/, '歧义前缀不该删掉任何一条')

    const gone = await byName.seed_forget.execute({ id: a.id })
    assert.match(gone.text, /已删除/)
    db.close()
  } finally {
    env.cleanup()
  }
})

test('打包清单带上 asr 脚本（默认路径就指向包里的 asr/asr_once.py）', async () => {
  const root = new URL('../', import.meta.url)
  const { readFileSync, existsSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
  assert.ok(pkg.files.includes('asr'), 'files 里要带 asr')
  assert.ok(existsSync(new URL('asr/asr_once.py', root)), 'asr/asr_once.py 要真的在')
})

test('打包别把 python 的 __pycache__ 带出去', async () => {
  // asr 整个目录进包；里面要是留着 __pycache__/*.pyc，别人装完会看到一堆本机字节码
  const root = decodeURIComponent(new URL('../', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
  const bad = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__pycache__') bad.push(full)
        else walk(full)
        continue
      }
      if (/\.pyc$/i.test(entry.name)) bad.push(full)
    }
  }
  walk(join(root, 'asr'))
  assert.deepEqual(bad, [], 'asr 里不该有 __pycache__ / .pyc：' + bad.join(', '))
})
test('保存 QQ 设置：连接参数没变就不重连，变了才重连', async () => {
  const env = makeEnv()
  apply(env.ctx, {
    budget: 600,
    qq: { enabled: false, wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1', allowPrivate: ['10001'] },
  })
  try {
    const route = env.routes.find((entry) => entry.path === '/dsh-seed-of-memory/qq/config')
    assert.ok(route, '没注册 /qq/config')
    const post = (body) =>
      new Promise((resolve) => {
        const req = new EventEmitter()
        req.method = 'POST'
        const res = {
          writableEnded: false,
          writeHead(status) {
            this.status = status
          },
          end(text) {
            this.body = String(text)
            this.writableEnded = true
            resolve(this)
          },
        }
        route.handler(req, res)
        req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
        req.emit('end')
      })

    const same = await post({ allowPrivate: ['10001', '10002'], autoReply: true })
    const first = JSON.parse(same.body)
    assert.equal(first.ok, true)
    assert.equal(first.restarted, true, '改了白名单就该重建通道（通道只在建的时候读配置）')

    const moved = await post({ wsUrl: 'ws://127.0.0.1:2' })
    assert.equal(JSON.parse(moved.body).restarted, true, '换地址要重连')
  } finally {
    env.cleanup()
  }
})
test('缺必填参数的时候给一句用法，不是抛错', async () => {
  const env = makeEnv()
  apply(env.ctx, { budget: 600 })
  try {
    for (const name of ['seed_remember', 'seed_believe', 'seed_trait', 'seed_aspire', 'seed_habit', 'seed_feel']) {
      const def = env.tools.find((tool) => tool.name === name)
      assert.ok(def, `没注册 ${name}`)
      const out = await def.execute({})
      const text = typeof out === 'string' ? out : out?.text
      assert.equal(typeof text, 'string', `${name} 没返回文字`)
      assert.ok(text.trim().length > 0, `${name} 什么都不说`)
    }
  } finally {
    env.cleanup()
  }
})

test('词表 json 也进包（少了它情绪内核会静默失灵）', async () => {  const root = new URL('../', import.meta.url)
  const { readFileSync, existsSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
  assert.ok(pkg.files.includes('lib'), 'files 里要带 lib')
  assert.ok(existsSync(new URL('lib/qing-words.json', root)), 'lib/qing-words.json 要真的在')
  const words = JSON.parse(readFileSync(new URL('lib/qing-words.json', root), 'utf8'))
  assert.ok(Array.isArray(words.PRAISE) && words.PRAISE.length > 0, '词表不能是空的')
})
test('挂着的能列出来、也能一句话定下来', async () => {
  const env = makeEnv()
  apply(env.ctx, { budget: 600 })
  try {
    // 先造一条「挂起」：他说的 + 我猜的撞了同一个键
    const remember = env.tools.find((t) => t.name === 'seed_remember')
    assert.ok(remember, '没注册 seed_remember')
    const remembered = await remember.execute({
      text: '他住在南京', layer: 'semantic', factKey: '他.城市',
    })
    assert.match(remembered.text, /已记住/)
    const guessed = await remember.execute({
      text: '他其实常年在杭州，外婆家在那儿', layer: 'semantic', factKey: '他.城市',
      source: 'inferred', confidence: 0.85,
    })
    assert.match(guessed.text, /conflict/)

    const list = await env.commands[0].execute('pending')
    assert.match(list.text, /挂着 1 条/)
    assert.match(list.text, /杭州/)

    // 不给 id 只说用法
    const usage = await env.commands[0].execute('keep')
    assert.match(usage.text, /用法：\/seed keep <id>/)

    // 用列表里那个前缀把它定下来
    const id = (list.text.match(/- (m_[a-z0-9]+)/) ?? [])[1]
    assert.ok(id, '列表里该有 id：' + list.text)
    const kept = await env.commands[0].execute(`keep ${id}`)
    assert.match(kept.text, /好，这条定下来了/)

    const after = await env.commands[0].execute('pending')
    assert.match(after.text, /没有挂着的/)

    const status = await env.commands[0].execute('status')
    assert.ok(!/待定/.test(status.text), '定下来之后不该再报待定：' + status.text.slice(0, 60))
  } finally {
    env.cleanup()
  }
})

test('空搜索词给用法，不是把记忆全倒出来', async () => {
  const env = makeEnv()
  apply(env.ctx, { budget: 600 })
  try {
    await env.tools.find((t) => t.name === 'seed_remember').execute({ text: '他喜欢夜里听雨', layer: 'semantic' })
    const out = await env.commands[0].execute('search')
    assert.match(out.text, /用法：\/seed search/)
  } finally {
    env.cleanup()
  }
})
test('打包目录里别混进临时/备份文件', () => {
  // lib 整个会被打进 npm 包：里面混一个 index.js.bak-…，装到别人机器上就是一堆看不懂的旧代码
  const root = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const strays = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      // .json 是数据文件（词表就在 lib/qing-words.json），其余一律不许进包
      if (!/\.(js|json)$/.test(entry.name)) strays.push(full)
    }
  }
  walk(join(decodeURIComponent(root), 'lib'))
  assert.deepEqual(strays, [], 'lib 里只该有 .js / .json：' + strays.join(', '))
})
test('/seed 每条子命令都得给句话，别沉默', async () => {
  const env = makeEnv()
  apply(env.ctx, { budget: 600 })
  try {
    const command = env.commands[0]
    const subs = [
      'status', 'self', 'persona', 'style', 'mood', 'pending',
      'search', 'search 雨', 'search ' + '雨'.repeat(600),
      'remember', 'remember 他喜欢夜里听雨',
      'why', 'why zzzz', 'why ' + 'm_'.repeat(300),
      'forget', 'forget zzzz', 'forget ' + 'x'.repeat(500),
      'anchor', 'anchor 他答应过周末陪我看海', 'anchor ' + '雨'.repeat(1000),
      'grow', 'grow 我说话短一点',
      'feel', 'feel 今天有点累',
      'believe', 'believe 他不喜欢被催',
      'aspire', 'aspire 可爱温柔带点任性',
      'trait', 'trait 温柔', 'trait 抢话 -0.1',
      'habit', 'habit 先接一句',
      'keep', 'keep zzzz', 'keep m_',
      'consolidate', 'sources',
      'backup', 'export',
      'help', 'bogus', '', '   ',
      'remember ' + '长'.repeat(5000),
    ]
    for (const sub of subs) {
      const out = await command.execute(sub)
      assert.equal(typeof out?.text, 'string', `「/seed ${sub.slice(0, 20)}」没给文字：` + JSON.stringify(out)?.slice(0, 120))
      assert.ok(out.text.trim().length > 0, `「/seed ${sub.slice(0, 20)}」给了一句空的`)
    }
  } finally {
    env.cleanup()
  }
})

test('/seed open 和 /seed forget：打开一条、删掉一条（前缀对上多条时不闷头删）', async () => {
  const env = makeEnv()
  try {
    apply(env.ctx, { budget: 600 })
    const byName = Object.fromEntries(env.tools.map((t) => [t.name, t]))
    const wrote = await byName.seed_remember.execute({ text: '他答应周末陪我去看海', layer: 'semantic' })
    const id = wrote.text.match(/(m_[a-z0-9]+)$/)[1]
    // 隔几毫秒再写第二条：同一毫秒的 id 前缀会撞上，那是另一条用例在测的
    await new Promise((resolve) => setTimeout(resolve, 5))
    await byName.seed_remember.execute({ text: '他喜欢夜里听雨', layer: 'semantic' })

    const opened = await env.commands[0].execute(`open ${id}`)
    assert.match(opened.text, /他答应周末陪我去看海/)
    assert.match(opened.text, /semantic/)

    const tooShort = await env.commands[0].execute('forget m')
    assert.match(tooShort.text, /用法：\/seed forget/)

    const removed = await env.commands[0].execute(`forget ${id}`)
    assert.match(removed.text, /已删除/)
    const after = await env.commands[0].execute('status')
    assert.match(after.text, /共 1 条/)
  } finally {
    env.cleanup()
  }
})

test('熟人卡：工具能写能读，也能删', async () => {
  const env = makeEnv()
  try {
    apply(env.ctx, { budget: 600 })
    const tool = env.tools.find((t) => t.name === 'seed_contact')
    assert.ok(tool, '没有 seed_contact 工具')

    const bad = await tool.execute({ action: 'set', peer: '100000001', name: '小忆' })
    assert.match(bad.text, /peer/)

    const wrote = await tool.execute({
      action: 'set',
      peer: 'private:100000001',
      name: '雁雪',
      relation: '老朋友',
      likes: '夜里听雨',
    })
    assert.match(wrote.text, /记下了/)
    assert.match(wrote.text, /雁雪/)

    const got = await tool.execute({ action: 'get', peer: 'private:100000001' })
    assert.match(got.text, /\[熟人\]/)
    assert.match(got.text, /夜里听雨/)

    const list = await tool.execute({ action: 'list' })
    assert.match(list.text, /private:100000001/)

    const gone = await tool.execute({ action: 'forget', peer: 'private:100000001' })
    assert.match(gone.text, /删了/)
    const again = await tool.execute({ action: 'get', peer: 'private:100000001' })
    assert.match(again.text, /还没/)
  } finally {
    env.cleanup()
  }
})

test('未完话头：记一条、列出来、收掉', async () => {
  const env = makeEnv()
  try {
    apply(env.ctx, { budget: 600 })
    const tool = env.tools.find((t) => t.name === 'seed_loose')
    assert.ok(tool, '没有 seed_loose 工具')

    const empty = await tool.execute({ action: 'list' })
    assert.match(empty.text, /没有/)

    const added = await tool.execute({ action: 'add', peer: 'private:100000001', ask: '周末去山里吗？' })
    assert.match(added.text, /记下了/)

    // 同一句不堆第二条
    await tool.execute({ action: 'add', peer: 'private:100000001', ask: '周末去山里吗？' })
    const list = await tool.execute({ action: 'list' })
    assert.equal((list.text.match(/周末去山里吗/g) ?? []).length, 1, list.text)
    const id = (list.text.match(/l_[a-z0-9]+/) ?? [])[0]
    assert.ok(id, list.text)

    const closed = await tool.execute({ action: 'done', id: id.slice(0, 8), note: '去了' })
    assert.match(closed.text, /收掉/)
    const after = await tool.execute({ action: 'list' })
    assert.match(after.text, /没有/)
  } finally {
    env.cleanup()
  }
})
