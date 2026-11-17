import test from 'node:test'
import assert from 'node:assert/strict'

import { splitVoiceNote, trimTailText } from '../lib/qq/channel.js'

test('没写 [语音]：say 是空的，正文一个字不动', () => {
  const { body, say } = splitVoiceNote('今天有点累，早点睡。')
  assert.equal(say, '')
  assert.equal(body, '今天有点累，早点睡。')
})

test('独占一行的 [语音]：摘出来，正文里不留', () => {
  const { body, say } = splitVoiceNote('我在呢。\n[语音]这边好啦，你听一下有没有断。')
  assert.equal(say, '这边好啦，你听一下有没有断。')
  assert.equal(body, '我在呢。')
})

test('中文方括号【语音】也认', () => {
  const { body, say } = splitVoiceNote('【语音】晚安咯。')
  assert.equal(say, '晚安咯。')
  assert.equal(body, '')
})

test('行首有空格 / 全角空格也认', () => {
  const { say } = splitVoiceNote('正文\n  [语音]  带着空格也能念  ')
  assert.equal(say, '带着空格也能念')
})

test('写了多条就合起来念', () => {
  const { body, say } = splitVoiceNote('甲\n[语音]第一句\n乙\n[语音]第二句')
  assert.equal(say, '第一句 第二句')
  assert.equal(body, '甲\n\n乙')
})

test('只有标记没有正文：正文空着，只发语音', () => {
  const { body, say } = splitVoiceNote('[语音]就这一句。')
  assert.equal(say, '就这一句。')
  assert.equal(body, '')
})

test('句中的 [语音] 不算标记（那是正文里的话）', () => {
  const { body, say } = splitVoiceNote('我说了[语音]这个词，它不该被摘走。')
  assert.equal(say, '')
  assert.equal(body, '我说了[语音]这个词，它不该被摘走。')
})

test('标记后面空着：那一行连壳一起丢掉，不念空话', () => {
  const { body, say } = splitVoiceNote('正文\n[语音]\n后面还有')
  assert.equal(say, '')
  // 删掉中间那行，前后就成了两个段落——这是正常的段落间隔，不再收窄
  assert.equal(body, '正文\n\n后面还有')
})

test('摘走以后不留一串空行', () => {
  const { body } = splitVoiceNote('第一段\n\n[语音]念这句\n\n第二段')
  assert.equal(body, '第一段\n\n第二段')
})

test('收尾沉默只吃正文，不会把语音那句一起吃掉', () => {
  const { body, say } = splitVoiceNote('说完了\n[语音]好呀')
  assert.equal(say, '好呀')
  // 正文只剩「说完了」，收尾沉默觉得太短，原样留着——语音那句不受影响
  assert.equal(trimTailText(body), '说完了')
})
