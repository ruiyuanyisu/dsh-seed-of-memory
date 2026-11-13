/**
 * 语音能力探测：不是每个用插件的人都装了本地语音。
 *
 * - ASR（听）：看 asrPython 与 asrScript 是否都配了、脚本是否真的存在。
 * - TTS（说）：看 ttsUrl 是否配了、那个地址是否真的能连上。
 *
 * 没装的时候不报错、不刷日志，也不假装发了语音——直接退回文字，
 * 面板里说明「为什么现在是纯文字」。
 */

import { existsSync } from 'node:fs'

export const VOICE_NOTICE = '（这条是语音。我这边没装语音识别，暂时听不到内容——可以打字，或者装一下语音模块）'

export const VOICE_HINT =
  '没装语音也能用：收到语音条会提示一次「听不到」，回复自动走文字。想听/想说，装 dsh-voice，或在 qq.json 里填 ttsUrl（GPT-SoVITS api_v2）与 asrPython + asrScript。'

/** ASR 配置是否齐全（不看服务是否已经在跑）。 */
export function asrConfigStatus(config = {}) {
  const python = String(config.asrPython ?? '').trim()
  const script = String(config.asrScript ?? '').trim()
  if (!python && !script) return { ok: false, reason: '没配置语音识别（asrPython / asrScript）' }
  if (!python) return { ok: false, reason: '没配置 asrPython' }
  if (!script) return { ok: false, reason: '没配置 asrScript' }
  if (!existsSync(script)) return { ok: false, reason: `识别脚本不存在：${script}` }
  return { ok: true, reason: '', python, script }
}

/**
 * TTS 地址能不能连上。只要 HTTP 有响应（哪怕 404）就算「在」，网络错误才算不在。
 * 不发送任何合成请求，避免探测本身很贵。
 */
export async function probeTts(url, { fetchImpl = globalThis.fetch, timeoutMs = 900 } = {}) {
  const target = String(url ?? '').trim()
  if (!target) return { ok: false, reason: '没配置语音合成地址（ttsUrl）' }
  if (typeof fetchImpl !== 'function') return { ok: false, reason: '当前环境不支持探测 ttsUrl' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(200, Number(timeoutMs) || 900))
  try {
    await fetchImpl(target.replace(/\/$/, '') + '/', { method: 'GET', signal: controller.signal })
    return { ok: true, reason: '' }
  } catch (error) {
    const message = String(error?.name === 'AbortError' ? '连接超时' : (error?.message ?? error))
    return { ok: false, reason: `连不上 ttsUrl：${message.slice(0, 120)}` }
  } finally {
    clearTimeout(timer)
  }
}

/** 一次完整探测：听 + 说各能不能。 */
export async function voiceCapability(config = {}, options = {}) {
  const asr = asrConfigStatus(config)
  const tts = await probeTts(config.ttsUrl, options)
  return {
    tts: { ok: Boolean(tts.ok), reason: tts.reason || '', url: String(config.ttsUrl ?? '') },
    asr: { ok: Boolean(asr.ok), reason: asr.reason || '', script: asr.script ?? '' },
    any: Boolean(tts.ok || asr.ok),
    textOnly: !tts.ok && !asr.ok,
  }
}

/** 短缓存：面板反复打开、每条消息都探测一次太浪费。 */
export class VoiceProbe {
  constructor({ ttlMs = 60_000, now = () => Date.now(), probe = voiceCapability } = {}) {
    this.ttlMs = ttlMs
    this.now = now
    this.probe = probe
    this.at = 0
    this.value = null
  }

  async get(config, { force = false } = {}) {
    const fresh = this.value && this.now() - this.at < this.ttlMs
    if (fresh && !force) return this.value
    this.value = await this.probe(config)
    this.at = this.now()
    return this.value
  }
}
