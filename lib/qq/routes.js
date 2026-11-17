/**
 * routes.js —— 一条 QQ 消息该不该接、接进哪条会话、记忆落哪一档。
 *
 * 取自朋友那份 router.js（他同意并进主干），这里做了几处收紧：
 *   - 形状写错不再静默退回：validateRoutes() 会给出 warnings，坏的条目丢掉。
 *   - gateRules 的 ttlSec 缺省不再是 0（那等于永久放行），默认 900 秒。
 *   - defaultRoutes 的 cwd 用配置里的（没配才用 process.cwd()），不跟着宿主进程跑。
 *   - memoryScope 只留 shared / gui / qq 三档：别的名字（工作区标签那种）一律算 qq，
 *     免得 seed_remember 的枚举对不上、记忆写不进去。
 *
 * 纯函数，不碰 I/O。
 */
import { createHash } from 'node:crypto'

/** 记忆档位：和 Seed 的 scope 枚举对齐。 */
export const MEMORY_SCOPES = ['shared', 'gui', 'qq']

/** 等指令的规则，缺 ttlSec 时按这个算（秒）。 */
export const DEFAULT_GATE_TTL_SEC = 900

/** 把 windows 路径揉成稳定的短 id：F:\守岸人\workspace → ws-6f2a1c */
export function workspaceTag(dir) {
  // 正斜杠也统一成反斜杠再算哈希：同一条路径两种写法要得到同一个标签
  const s = String(dir ?? '').trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
  if (!s) return 'ws-default'
  const name = s.split(/[\\/]/).pop() || 'default'
  const h = createHash('sha1').update(s).digest('hex').slice(0, 6)
  const safe = name.replace(/[^a-z0-9_-]/gi, '') || 'ws'
  return `ws-${safe}-${h}`
}

/** 没配 routes 时用的默认表：一个号，谁都能来，记忆按工作区分。 */
export function defaultRoutes(workspace) {
  const cwd = String(workspace ?? '').trim() || process.cwd()
  return [
    {
      id: 'main',
      workspace: cwd,
      cwd,
      accept: { private: ['*'], groups: ['*'] },
      memoryScope: 'qq',
      gate: null,
    },
  ]
}

function asList(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item))
}

function hit(list, id) {
  const values = asList(list)
  return values.includes('*') || values.includes(String(id))
}

function senderOf(ev) {
  return String(ev?.sender?.user_id ?? ev?.user_id ?? ev?.sender?.userId ?? '')
}

function subjectOf(ev) {
  if (ev?.message_type === 'private') return String(ev?.user_id ?? '')
  if (ev?.message_type === 'group') return String(ev?.group_id ?? '')
  return ''
}

/**
 * 把 memoryScope 收成 Seed 认的三档。
 * 不认识的（比如朋友那种 ws-shorekeeper-main:tsuki）算 qq —— 它本来就是 QQ 通道的会话。
 */
export function normalizeScope(scope, { warn = null } = {}) {
  const value = String(scope ?? '').trim().toLowerCase()
  if (MEMORY_SCOPES.includes(value)) return value
  // 降级方向是安全的（'qq' = 按人自动分，配错也不会串），但以前一声不吭：
  // 手快写个 'work' 或 'qq:123'，以为分开了，其实全落自动分档（REVIEW-151 第十三轮）。
  if (warn) warn(`memoryScope「${scope}」认不出，按 qq（自动按人分）算`)
  return 'qq'
}

/**
 * 校验配置形状。返回收好的表和 warnings；坏条目丢掉、不炸。
 * routes / gateRules / orderTriggers 写错形状时，以前是静默退回默认表——现在能看见。
 */
export function validateRoutes(config = {}) {
  const warnings = []
  const fallbackCwd = String(config.cwd ?? '').trim()

  let routes = []
  if (config.routes === undefined) {
    routes = defaultRoutes(fallbackCwd)
  } else if (!Array.isArray(config.routes)) {
    warnings.push('routes 应该是数组，已按默认路由处理')
    routes = defaultRoutes(fallbackCwd)
  } else {
    routes = config.routes
      .filter((route) => route && typeof route === 'object')
      .map((route, index) => {
        const id = String(route.id ?? `route-${index + 1}`).trim() || `route-${index + 1}`
        const accept = route.accept && typeof route.accept === 'object' ? route.accept : {}
        if (route.accept !== undefined && (typeof route.accept !== 'object' || route.accept === null)) {
          warnings.push(`routes[${id}].accept 应该是 { private: [], groups: [] }，已按空处理`)
        }
        if (route.accept?.private !== undefined && !Array.isArray(route.accept.private)) {
          warnings.push(`routes[${id}].accept.private 应该是数组，已按空处理`)
        }
        if (route.accept?.groups !== undefined && !Array.isArray(route.accept.groups)) {
          warnings.push(`routes[${id}].accept.groups 应该是数组，已按空处理`)
        }
        if (route.onlyFor !== undefined && !Array.isArray(route.onlyFor)) {
          warnings.push(`routes[${id}].onlyFor 应该是数组，已忽略`)
        }
        return {
          id,
          workspace: String(route.workspace ?? '').trim(),
          cwd: String(route.cwd ?? route.workspace ?? fallbackCwd).trim(),
          accept: {
            private: asList(accept.private),
            groups: asList(accept.groups),
          },
          memoryScope: normalizeScope(route.memoryScope, {
            warn: (note) => warnings.push(`routes[${id}] ${note}`),
          }),
          onlyFor: asList(route.onlyFor),
        }
      })
    if (routes.length === 0) {
      warnings.push('routes 里没有一条能用的，已按默认路由处理')
      routes = defaultRoutes(fallbackCwd)
    }
  }

  let gateRules = []
  if (config.gateRules !== undefined) {
    if (!Array.isArray(config.gateRules)) {
      warnings.push('gateRules 应该是数组，已忽略')
    } else {
      gateRules = config.gateRules
        .filter((rule) => rule && typeof rule === 'object')
        .map((rule, index) => {
          const when = rule.when && typeof rule.when === 'object' ? rule.when : {}
          const ttl = rule.ttlSec === undefined ? DEFAULT_GATE_TTL_SEC : Number(rule.ttlSec)
          if (rule.ttlSec !== undefined && !Number.isFinite(ttl)) {
            warnings.push(`gateRules[${rule.id ?? index}].ttlSec 不是数字，已按 ${DEFAULT_GATE_TTL_SEC} 秒`)
          }
          if (!rule.requireOrderFrom) {
            warnings.push(`gateRules[${rule.id ?? index}].requireOrderFrom 是空的，这条规则不会生效`)
          }
          return {
            id: String(rule.id ?? `gate-${index + 1}`),
            when: {
              from: when.from === undefined ? undefined : String(when.from),
              route: when.route === undefined ? undefined : String(when.route),
              type: when.type === undefined ? undefined : String(when.type),
            },
            requireOrderFrom: String(rule.requireOrderFrom ?? ''),
            ttlSec: Number.isFinite(ttl) ? ttl : DEFAULT_GATE_TTL_SEC,
          }
        })
        .filter((rule) => rule.requireOrderFrom !== '')
    }
  }

  let orderTriggers = []
  if (config.orderTriggers !== undefined) {
    if (Array.isArray(config.orderTriggers)) orderTriggers = asList(config.orderTriggers).filter(Boolean)
    else warnings.push('orderTriggers 应该是字符串数组，已忽略')
  }

  if (config.defaultAccount !== undefined) {
    warnings.push('defaultAccount 不再使用（插件是单号），已忽略')
  }

  // 顶层 memoryScope 也回显出来：以前它只在 memoryScopeFor 里被读，
  // 「我在顶层配了 shared 到底生效没有」从返回值里看不出来（REVIEW-151 第十三轮）。
  const topScope =
    config.memoryScope === undefined
      ? undefined
      : normalizeScope(config.memoryScope, { warn: (note) => warnings.push(note) })

  return {
    routes,
    gateRules,
    orderTriggers,
    ...(topScope === undefined ? {} : { memoryScope: topScope }),
    warnings,
  }
}

/** 一条路由认不认这条消息。 */
function routeAccepts(route, ev) {
  const sender = senderOf(ev)
  if (ev?.message_type === 'private') {
    if (!hit(route?.accept?.private, sender)) return false
  } else if (ev?.message_type === 'group') {
    if (!hit(route?.accept?.groups, subjectOf(ev))) return false
  } else {
    return false
  }
  if (Array.isArray(route?.onlyFor) && route.onlyFor.length) {
    if (!hit(route.onlyFor, sender)) return false
  }
  return true
}

/** 命中哪条 gateRule。 */
function gateFor(ev, route, gateRules) {
  const sender = senderOf(ev)
  for (const rule of gateRules) {
    const when = rule.when ?? {}
    if (when.from !== undefined && String(when.from) !== sender) continue
    if (when.route !== undefined && String(when.route) !== String(route?.id)) continue
    if (when.type !== undefined && String(when.type) !== String(ev?.message_type)) continue
    return rule
  }
  return null
}

/** orders 里有没有一条还新鲜的、由 orderFrom 发出的指令。 */
export function orderFresh(orders, { from, routeId, now = Date.now(), ttlSec } = {}) {
  const list = Array.isArray(orders) ? orders : []
  const seconds = ttlSec === undefined ? DEFAULT_GATE_TTL_SEC : Number(ttlSec)
  const ttl = Math.max(0, Number.isFinite(seconds) ? seconds : DEFAULT_GATE_TTL_SEC) * 1000
  for (let i = list.length - 1; i >= 0; i--) {
    const order = list[i]
    if (!order) continue
    if (String(order.from) !== String(from)) continue
    if (routeId !== undefined && String(order.routeId ?? '') !== String(routeId)) continue
    if (Number(now) - Number(order.at ?? 0) > ttl) continue
    return order
  }
  return null
}

/**
 * 主判定。
 *
 * @returns {{
 *   allow: boolean, key: string, routeId: string, cwd: string,
 *   memoryScope: string, gated: boolean, reason: string
 * }}
 */
export function routeOf(ev, config = {}, { now = Date.now(), orders = [] } = {}) {
  const deny = (reason) => ({
    allow: false,
    key: '',
    routeId: '',
    cwd: '',
    memoryScope: 'qq',
    gated: false,
    reason,
  })

  if (ev?.message_type !== 'private' && ev?.message_type !== 'group') {
    return deny('既不是私聊也不是群聊')
  }

  const checked = validateRoutes(config)
  const key = ev.message_type === 'private' ? `private:${subjectOf(ev)}` : `group:${subjectOf(ev)}`

  for (const route of checked.routes) {
    if (!routeAccepts(route, ev)) continue

    const rule = gateFor(ev, route, checked.gateRules)
    if (rule) {
      const ok = orderFresh(orders, { from: rule.requireOrderFrom, routeId: route.id, now, ttlSec: rule.ttlSec })
      if (!ok) {
        return {
          allow: false,
          key,
          routeId: route.id,
          cwd: route.cwd,
          memoryScope: route.memoryScope,
          gated: true,
          reason: `等 ${rule.requireOrderFrom} 的指令（规则 ${rule.id}）`,
        }
      }
    }

    return {
      allow: true,
      key,
      routeId: route.id,
      cwd: route.cwd,
      memoryScope: route.memoryScope,
      gated: false,
      reason: `路由 ${route.id} 接下`,
      warnings: checked.warnings,
    }
  }

  // 白名单里的人不该因为「没配路由」就被挡在门外——
  // allowPrivate / allowGroups 本来就是「谁能跟我说话」的名单，
  // 而 routes 是「接到之后放哪个工作区」。两回事，别让后者的缺席把前者作废。
  const inList =
    ev.message_type === 'private'
      ? hit(asList(config.allowPrivate), subjectOf(ev))
      : hit(asList(config.allowGroups), subjectOf(ev))
  if (inList) {
    return {
      allow: true,
      key,
      routeId: '',
      cwd: String(config.cwd ?? ''),
      memoryScope: normalizeScope(config.memoryScope),
      gated: false,
      reason: '白名单（没配路由，走默认）',
      warnings: checked.warnings,
    }
  }

  return deny('没有一条路由认它')
}

/** 这句话是不是「给某个人发指令」——命中 orderTriggers 就当一条 order。 */
export function isOrder(text, triggers) {
  const body = String(text ?? '')
  if (!body) return false
  return asList(triggers).some((trigger) => trigger && body.includes(trigger))
}
