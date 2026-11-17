/**
 * 原 test-body-prefix.mjs：把「谁说的」写进正文——群里要说清是谁，老大本人私聊不加前缀。
 * 接口差异：他是在正文前面加〔群｜昵称（号）说的〕前缀，
 * 我是在正文末尾加一句「[这条来自群 X，是张三（QQ 20001）说的……]」（channel 里 fromLine 那套），
 * 问的是同一件事：模型看得出这句是谁说的。断言按我的实际文案写。
 */
import { assert, groupEvent, makeChannel, pass, privateEvent } from './_lib.mjs'

/** 发一条，取出发给模型的那段正文。 */
async function bodyOf({ config = {}, event }) {
  const { channel, agents } = makeChannel({ config })
  channel.start()
  await channel.handleEvent(event)
  const message = agents.created[0]?.message
  await channel.stop()
  return message?.content?.find((c) => c.type === 'text')?.text ?? ''
}

// ① 群里张三说的：正文里要有昵称和号，还要提醒「别把别人说的当成老大说的」
const groupText = await bodyOf({
  config: { ownerQQ: '10001', groupRequireAt: false },
  event: groupEvent({ userId: 20001, card: '张三', text: '今天下雨了' }),
})
assert.ok(groupText.includes('张三'), `群里该说清是谁：${groupText}`)
assert.ok(groupText.includes('20001'), '还要带上号，同名同姓的人多')
assert.ok(groupText.includes('群'), '要说这条来自群')
assert.ok(
  groupText.includes('别把别人说的当成老大说的'),
  `要提醒模型别认错人：${groupText}`,
)

// ② 老大本人私聊：不加那句「不是老大本人」的提示
const ownerText = await bodyOf({
  config: { ownerQQ: '10001' },
  event: privateEvent({ userId: 10001, text: '在吗' }),
})
assert.ok(!ownerText.includes('不是老大本人'), `老大自己的消息不该被当外人：${ownerText}`)

// ③ 别人私聊：要说清不是老大本人
const guestText = await bodyOf({
  config: { ownerQQ: '10001', allowPrivate: ['10001', '20002'] },
  event: privateEvent({ userId: 20002, text: '你好' }),
})
assert.ok(guestText.includes('不是老大本人'), `别人的私聊要说清身份：${guestText}`)

pass('body-prefix：谁说的写进正文——群里带昵称和号，老大自己不带「外人」提示')
