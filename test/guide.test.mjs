import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const guide = readFileSync(new URL('docs/GUIDE.md', root), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const index = readFileSync(new URL('lib/index.js', root), 'utf8')

test('说明书覆盖关键章节', () => {
  for (const heading of ['## 它是什么', '## 安装与升级', '## 离线资源', '## 面板每一页', '## 工具', '## 配置', '## QQ', '## 常见问题']) {
    assert.ok(guide.includes(heading), `缺少章节：${heading}`)
  }
  assert.ok(guide.includes('resources-v0.18.1'), '资源说明应指向 resources release')
  assert.ok(guide.includes('vmys'), '应保留迅雷提取码')
  assert.ok(guide.includes('proactive.target'), '应说明主动消息目标配置')
  assert.ok(guide.includes('groupPolicy'), '应说明群聊三档')
})

test('docs 随包发布，版本号可读', () => {
  assert.ok(pkg.files.includes('docs'), 'package.json files 应包含 docs')
  assert.match(String(pkg.version), /^\d+\.\d+\.\d+$/)
})

test('插件注册了 guide 路由并读取 docs/GUIDE.md', () => {
  assert.ok(index.includes("path: '/dsh-seed-of-memory/guide'"))
  assert.ok(index.includes("new URL('../docs/GUIDE.md', import.meta.url)"))
})
