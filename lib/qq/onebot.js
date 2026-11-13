/**
 * OneBot 11 客户端（SnowLuma / NapCat 通用）。
 *
 * 只做三件事：连上 WS、收事件、调 API。
 * - WS 走 `?access_token=`（OneBot 11 的通用写法）；
 * - API 优先走 WS 的 echo，断线时退回 HTTP（Authorization: Bearer）。
 * 不依赖任何第三方库；重连用 1s → 2s → … → 30s 的退避。
 */
import { EventEmitter } from 'node:events'

const MAX_BACKOFF_MS = 30_000

function withToken(url, token) {
  if (!token) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}access_token=${encodeURIComponent(token)}`
}

export class OneBotClient extends EventEmitter {
  #ws = null
  #stop = false
  #timer = null
  #attempt = 0
  #echo = 0
  #pending = new Map()
  #state = { connected: false, connecting: false, selfId: '', lastError: '', connects: 0, events: 0, lastAt: 0 }

  constructor({ wsUrl = 'ws://127.0.0.1:3001', httpUrl = 'http://127.0.0.1:3000', token = '', logger = console } = {}) {
    super()
    this.wsUrl = wsUrl
    this.httpUrl = String(httpUrl || '').replace(/\/+$/, '')
    this.token = token
    this.logger = logger
  }

  get connected() {
    return this.#state.connected
  }

  status() {
    return { ...this.#state, pending: this.#pending.size, wsUrl: this.wsUrl }
  }

  connect() {
    this.#stop = false
    this.#open()
    return this
  }

  close() {
    this.#stop = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    this.#state.connected = false
    this.#state.connecting = false
    try {
      this.#ws?.close()
    } catch {
      /* ignore */
    }
    this.#ws = null
    for (const [, waiter] of this.#pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('onebot: closed'))
    }
    this.#pending.clear()
  }

  #open() {
    if (this.#stop) return
    this.#state.connecting = true
    const url = withToken(this.wsUrl, this.token)
    let ws
    try {
      ws = new WebSocket(url)
    } catch (error) {
      this.#fail(error)
      this.#schedule()
      return
    }
    this.#ws = ws

    ws.addEventListener('open', () => {
      this.#attempt = 0
      this.#state.connected = true
      this.#state.connecting = false
      this.#state.connects += 1
      this.#state.lastError = ''
      this.emit('status', this.status())
      this.logger.info?.('[seed-of-memory] QQ 已连接 ' + this.wsUrl)
    })

    ws.addEventListener('message', (event) => {
      this.#onMessage(event.data)
    })

    ws.addEventListener('close', () => {
      this.#state.connected = false
      this.#state.connecting = false
      this.emit('status', this.status())
      this.#schedule()
    })

    ws.addEventListener('error', (event) => {
      const message = String(event?.message ?? event?.error?.message ?? 'ws error')
      this.#state.lastError = message
      this.emit('status', this.status())
    })
  }

  #schedule() {
    if (this.#stop) return
    if (this.#timer) clearTimeout(this.#timer)
    this.#attempt += 1
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(5, this.#attempt - 1))
    this.#timer = setTimeout(() => this.#open(), delay)
    this.#timer.unref?.()
  }

  #fail(error) {
    this.#state.lastError = String(error?.message ?? error)
    this.#state.connecting = false
    this.emit('status', this.status())
  }

  #onMessage(raw) {
    let payload
    try {
      payload = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }
    if (!payload || typeof payload !== 'object') return

    if (payload.echo !== undefined && payload.echo !== null && this.#pending.has(String(payload.echo))) {
      const waiter = this.#pending.get(String(payload.echo))
      this.#pending.delete(String(payload.echo))
      clearTimeout(waiter.timer)
      if (payload.status === 'ok' || payload.retcode === 0) waiter.resolve(payload.data)
      else waiter.reject(new Error(String(payload.wording ?? payload.message ?? 'onebot: api failed')))
      return
    }

    this.#state.events += 1
    this.#state.lastAt = Date.now()
    if (payload.post_type === 'meta_event' && payload.meta_event_type === 'lifecycle') {
      this.#state.selfId = String(payload.self_id ?? this.#state.selfId ?? '')
    } else if (payload.self_id) {
      this.#state.selfId = String(payload.self_id)
    }
    this.emit('event', payload)
  }

  /** 调 OneBot API：优先 WS echo，没有连接时走 HTTP。 */
  async call(action, params = {}, timeoutMs = 15_000) {
    if (this.#state.connected && this.#ws) {
      try {
        return await new Promise((resolve, reject) => {
          const echo = String(++this.#echo)
          const timer = setTimeout(() => {
            this.#pending.delete(echo)
            reject(new Error(`onebot: ${action} timeout`))
          }, timeoutMs)
          this.#pending.set(echo, { resolve, reject, timer })
          this.#ws.send(JSON.stringify({ action, params, echo }))
        })
      } catch (error) {
        if (!this.httpUrl) throw error
      }
    }
    if (!this.httpUrl) throw new Error('onebot: not connected')
    return this.#http(action, params, timeoutMs)
  }

  async #http(action, params, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${this.httpUrl}/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(params ?? {}),
        signal: controller.signal,
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || (data && data.status === 'failed')) {
        throw new Error(String(data?.wording ?? data?.message ?? `onebot: HTTP ${response.status}`))
      }
      return data?.data ?? data
    } finally {
      clearTimeout(timer)
    }
  }
}
