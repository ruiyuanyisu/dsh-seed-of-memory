import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const AUDIO_EXT = new Set(['.wav', '.mp3', '.silk', '.amr', '.ogg', '.m4a', '.flac'])
const MAX_AUDIO_BYTES = 25 * 1024 * 1024

/** 收集消息里所有语音段（OneBot record）。 */
export function recordSegments(segments) {
  return (Array.isArray(segments) ? segments : []).filter((seg) => seg && seg.type === 'record')
}

/** 把 OneBot 语音段的 data 化成 {file,url}，字段名在不同实现里略有差异。 */
export function recordDataOf(seg) {
  const data = seg?.data ?? {}
  return {
    file: String(data.file ?? data.path ?? ''),
    url: String(data.url ?? ''),
  }
}

function isAudio(file) {
  return AUDIO_EXT.has(extname(String(file)).toLowerCase())
}

/**
 * 把一条语音落到本地：优先直接用本地路径（SnowLuma 与本插件同机），
 * 其次走 get_record 让协议端给出文件，最后才按 url 下载。
 */
export async function resolveRecordFile({ client, seg, dir, logger = console }) {
  const { file, url } = recordDataOf(seg)
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* ignore */
  }

  const candidates = []
  if (file && existsSync(file) && isAudio(file)) candidates.push(file)
  if (file && !/^[a-z]+:\/\//i.test(file)) {
    const abs = resolve(file)
    if (existsSync(abs) && isAudio(abs)) candidates.push(abs)
  }
  if (candidates.length > 0) return candidates[0]

  if (file && client?.call) {
    try {
      const got = await client.call('get_record', { file, out_format: 'wav' }, 20000)
      const path = String(got?.file ?? got?.path ?? '')
      if (path && existsSync(path) && isAudio(path)) return path
      if (path && path.startsWith('base64://')) {
        const target = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.wav`)
        writeFileSync(target, Buffer.from(path.slice(9), 'base64'))
        return target
      }
    } catch (error) {
      logger?.warn?.('[seed-of-memory] get_record 失败：' + (error?.message ?? error))
    }
  }

  if (url) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.length > 0 && buffer.length <= MAX_AUDIO_BYTES) {
          const target = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.wav`)
          writeFileSync(target, buffer)
          return target
        }
      }
    } catch (error) {
      logger?.warn?.('[seed-of-memory] 语音下载失败：' + (error?.message ?? error))
    }
  }
  return ''
}

function runJson(command, args, { timeoutMs = 180000, env = process.env } = {}) {
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(command, args, { windowsHide: true, env })
    } catch (error) {
      return resolvePromise({ ok: false, error: String(error?.message ?? error) })
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      resolvePromise({ ok: false, error: 'timeout' })
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ ok: false, error: String(error?.message ?? error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const line = stdout
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .pop()
      try {
        const parsed = JSON.parse(line)
        resolvePromise({ ok: !parsed.error && code === 0, ...parsed, stderr })
      } catch {
        resolvePromise({ ok: false, error: stderr.trim() || `exit ${code}` })
      }
    })
  })
}

/** 本地 ASR：调用 bundled 的 asr/asr_once.py（优先）或配置里指定的脚本。 */
export async function transcribeFile(config, wavPath) {
  const python = String(config.asrPython ?? '').trim()
  const script = String(config.asrScript ?? '').trim()
  if (!python || !script || !existsSync(script)) return { ok: false, error: 'asr 未配置' }
  const args = [script, wavPath, '--model', String(config.asrModel || 'small')]
  if (config.asrModelsDir) args.push('--models-dir', String(config.asrModelsDir))
  const env = { ...process.env }
  if (config.asrTorchLib) env.PATH = `${config.asrTorchLib};${env.PATH ?? ''}`
  env.PYTHONIOENCODING = 'utf-8'
  const result = await runJson(python, args, { timeoutMs: Number(config.asrTimeoutMs) || 180000, env })
  return {
    ok: Boolean(result.ok && result.text),
    text: String(result.text ?? '').trim(),
    error: result.error ?? '',
    duration: result.duration,
  }
}

/** 本地 TTS：POST 到 GPT-SoVITS api_v2 的 /tts，落成 wav。 */
export async function synthesizeToFile(config, text) {
  const url = String(config.ttsUrl ?? '').trim()
  if (!url) return { ok: false, error: 'tts 未配置' }
  const body = {
    text,
    text_lang: String(config.ttsLang || 'zh'),
    ref_audio_path: String(config.refAudio ?? ''),
    prompt_text: String(config.refText ?? ''),
    prompt_lang: String(config.ttsLang || 'zh'),
    media_type: 'wav',
    streaming_mode: false,
    text_split_method: 'cut5',
    speed_factor: Number(config.ttsSpeed) || 1,
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number(config.ttsTimeoutMs) || 120000)
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return { ok: false, error: `tts ${response.status} ${detail.slice(0, 200)}` }
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length < 1000) return { ok: false, error: 'tts 返回空音频' }
    const dir = String(config.voiceDir ?? '').trim()
    mkdirSync(dir, { recursive: true })
    const target = join(dir, `say-${Date.now()}-${randomUUID().slice(0, 6)}.wav`)
    writeFileSync(target, buffer)
    return { ok: true, path: target, bytes: buffer.length }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

/** 音色文件的“像不像语音”粗判：交给调用方决定要不要走语音回复。 */
export function looksSpeakable(text, maxChars) {
  const value = String(text ?? '').trim()
  if (!value) return false
  const limit = Number(maxChars) || 80
  if (value.length > limit) return false
  if (/```|^\s*[-*|]|\bhttps?:\/\//i.test(value)) return false
  return true
}

export function voiceFileName(wavPath) {
  const name = basename(String(wavPath))
  return name || `voice-${Date.now()}.wav`
}

const VOICE_FILE_RE = /^say-\d+-[a-z0-9]+\.wav$/i

/**
 * 合成出来的语音攒着不会自己消失（一条 wav 常常几百 KB 到 1 MB），
 * 时间长了光这一目录就能吃几个 G。只清我们自己写的 `say-*.wav`：
 * 太旧的、以及超出最近 `keep` 份之外的；别人的文件（手动测试、收到的语音）一律不碰。
 */
export function pruneVoiceFiles(dir, { keep = 40, maxAgeMs = 7 * 86_400_000, now = Date.now() } = {}) {
  const target = String(dir ?? '').trim()
  if (!target || !existsSync(target)) return { removed: 0 }
  let files = []
  try {
    files = readdirSync(target, { withFileTypes: true })
      .filter((entry) => entry.isFile() && VOICE_FILE_RE.test(entry.name))
      .map((entry) => {
        const abs = join(target, entry.name)
        let mtime = 0
        try {
          mtime = statSync(abs).mtimeMs
        } catch {}
        return { abs, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return { removed: 0 }
  }
  let removed = 0
  files.forEach((file, index) => {
    const tooOld = maxAgeMs > 0 && now - file.mtime > maxAgeMs
    const tooMany = keep > 0 && index >= keep
    if (!tooOld && !tooMany) return
    try {
      unlinkSync(file.abs)
      removed += 1
    } catch {}
  })
  return { removed }
}

export function audioSize(wavPath) {
  try {
    return statSync(wavPath).size
  } catch {
    return 0
  }
}
