import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'

function makeEnv() {
  const home = mkdtempSync(join(tmpdir(), 'seed-home-'))
  process.env.DSH_HOME = home

  const tools = []
  const commands = []
  const prompts = []
  const disposers = []

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
    },
  }

  let onDispose = null

  const ctx = {
    inject(_names, callback) {
      return callback({
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
      })
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
  return { home, ctx, tools, commands, prompts, disposers, cleanup }
}

test('registers the six seed tools with valid schema', () => {
  const env = makeEnv()
  try {
    apply(env.ctx, { budget: 600 })
    const names = env.tools.map((t) => t.name).sort()
    assert.deepEqual(names, [
      'seed_anchor',
      'seed_aspire',
      'seed_believe',
      'seed_feel',
      'seed_forget',
      'seed_habit',
      'seed_mood',
      'seed_open',
      'seed_persona',
      'seed_remember',
      'seed_search',
      'seed_self',
      'seed_style',
      'seed_trait',
      'seed_why',
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

    const id = wrote.text.match(/（\w+）：([a-z0-9]+)/)[1]
    const why = await byName.seed_why.execute({ id })
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
