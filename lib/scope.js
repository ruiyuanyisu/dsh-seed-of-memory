/**
 * 键空间：谁说的话，算谁的记忆。
 *
 * 这里只有一个「scope」字符串，全库通用（memories.scope / beliefs.scope /
 * captures.slot / emotions.slot / affects.slot / qing_history.slot）：
 *
 *   shared        共用的：关于我自己的事、我们之间的约定，谁来都看得见
 *   gui           面板/本地会话里跟老大说的
 *   qq:<QQ号>     某个人的私聊
 *   group:<群号>   某个群
 *
 * 另外留了一个老桶 `qq`：1.4.x 时代群聊和私聊都写在这，不能因为分了人就把
 * 以前的记忆全丢掉。但也不能让谁都读 —— 那桶里混着好几个人的话，谁读都是串。
 * 所以现在只有「当面/面板」（gui）还看得见它：本人的地方，看自己的旧账不过分；
 * 任何一个 QQ 私聊、任何一个群，都不再读得到老桶（1.5.1 改的，见 REVIEW-150）。
 *
 * 注意 peers 是另一套键（`private:<号>` / `group:<群号>`），那是「这是谁」，
 * 用在 contacts / loose_ends / qq 历史里。两套键要能互推，所以都收在这里，
 * 别的文件不要再手拼字符串。
 */

/** 「当面 / 面板」这两个字以前混着用，统一叫 gui。 */
const GUI_ALIASES = new Set(['gui', 'me', 'local', 'panel', ''])

/**
 * 拿不到会话时，「记一条」该落哪儿。
 *
 * 只有一种正确答案：**当面**。
 * `shared` 在这套设计里特指「两人共用、谁来都看得见」，
 * 那必须是明确选出来的，不能是「没填就落这儿」——
 * 否则任何一处忘了传 scope 的调用，都会把话摊给所有人（REVIEW-151 第八、十二轮）。
 *
 * 四个写入口（命令 / 工具 / 面板 POST / importRecords）都引这一个常量。
 */
export const DEFAULT_WRITE_SCOPE = 'gui'

export function isShared(scope) {
  return !scope || scope === 'shared'
}

/**
 * 把一个 scope 收拾成规范写法；认不出来的原样返回（交给上层决定）。
 * 传 peer 键（private:/group:）也认，省得调用方先转一道。
 */
export function canonScope(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return 'shared'
  const lower = raw.toLowerCase()
  if (lower === 'shared') return 'shared'
  if (GUI_ALIASES.has(lower)) return 'gui'
  if (lower === 'qq') return 'qq'
  // 手写配置容易多空格（'qq: 1265073746'），收拾一下再认，别让它静默落进野档
  const privateMatch = /^private:\s*(\d+)$/.exec(lower)
  if (privateMatch) return `qq:${privateMatch[1]}`
  const groupMatch = /^group:\s*(\d+)$/.exec(lower)
  if (groupMatch) return `group:${groupMatch[1]}`
  if (/^qq:\s*\d+$/.test(lower)) return `qq:${lower.replace(/^qq:\s*/, '')}`
  if (/^group:\s*\d+$/.test(lower)) return `group:${lower.replace(/^group:\s*/, '')}`
  return raw
}

/** 是不是「某一个人/某一个群」的档（分人的那些），老桶和共用层不算。 */
export function isPersonScope(scope) {
  const own = canonScope(scope)
  return /^qq:\d+$/.test(own) || /^group:\d+$/.test(own)
}

/** peer 键 → scope：private:10001 → qq:10001；group:20002 → group:20002。 */
export function scopeOfPeer(peerKey) {
  const raw = String(peerKey ?? '').trim()
  if (!raw) return null
  const privateMatch = /^private:(\d+)$/.exec(raw)
  if (privateMatch) return `qq:${privateMatch[1]}`
  const groupMatch = /^group:(\d+)$/.exec(raw)
  if (groupMatch) return `group:${groupMatch[1]}`
  return null
}

/**
 * 会话 id 里缝着的号 → scope。
 * QQ 通道给的会话 id 形如 `seedqq-<sha1 前 16>-q10001` / `seedqq-…-g20002`：
 * 以前只有一串 sha1，重启后 Map 一空就没人知道这是谁的会话，
 * 旧会话全落进老桶 `qq`（REVIEW-150 第三轮）。现在号就写在 id 上。
 */
const SESSION_TAG_RE = /^seedqq-[0-9a-f]{8,32}-([qg])(\d{3,20})$/

export function scopeOfSessionId(sessionId) {
  const raw = String(sessionId ?? '').trim()
  if (!raw) return null
  const match = SESSION_TAG_RE.exec(raw)
  if (!match) return null
  return match[1] === 'g' ? `group:${match[2]}` : `qq:${match[2]}`
}

/** scope → peer 键，反着来一次。认不出来返回 null。 */
export function peerOfScope(scope) {
  const raw = canonScope(scope)
  if (/^qq:\d+$/.test(raw)) return `private:${raw.slice(3)}`
  if (/^group:\d+$/.test(raw)) return raw
  return null
}

/**
 * 这个 scope 能看见哪些档。
 * 读的时候一律走它，写的时候写自己的那一个 —— 这样旧 key 查询有没有漏，
 * 只要看它有没有经过这里。
 */
export function visibleScopes(scope) {
  const own = canonScope(scope)
  if (isShared(own)) return ['shared']
  // 面板/当面：本人的地方，连 1.4.x 那个老桶也读得到（升级前的旧账不至于看不见）
  if (own === 'gui') return ['shared', 'gui', 'qq']
  if (own === 'qq') return ['shared', 'qq']
  // qq:<号> / group:<群号>：只读共用的和自己那一档。
  // 老桶不在这里 —— 那桶里混着别人的话，谁读都是串（REVIEW-150 第一轮）。
  return ['shared', own]
}

/**
 * 生成一段 WHERE 片段 + 参数。
 * @param {string} column 列名，带表别名也行（'m.scope'）
 * @param {string} scope  当前说话人的档
 * @param {{sharedOnly?: boolean}} options sharedOnly=true 时只取共用的（面板总览用）
 * @returns {{sql: string, params: string[]}}
 */
/**
 * 这个 scope 还能看见哪些「前缀档」——名字列表表达不出来的那一类。
 *
 * 现在只有匿名档（`qq:anon-*`）：认不出会话时的落脚点，谁都不「拥有」它。
 * 单独成一个函数，是为了让 scopeFilter 与别处手写 SQL 的地方拿到同一个真相源
 * ——两处各拼一次，早晚分叉（REVIEW-153 第十轮）。
 */
export function visiblePrefixes(scope) {
  const own = canonScope(scope)
  return own === 'gui' ? ['qq:anon-'] : []
}

/**
 * 前缀档的上界。`'qq:anon-'` → `'qq:anon-\uffff'`。
 *
 * 以前写成「前缀末字符 + 1」（`-` → `.`），只在末字符是 `-` 时成立；
 * 哪天加一个以字母结尾的前缀，算出来的上界会比前缀小，区间为空、静默漏数据
 * （REVIEW-155 验收第五条 ②）。`\uffff` 比任何 ASCII 尾巴都大，不依赖末字符是什么。
 */
function prefixEnd(prefix) {
  return `${prefix}\uffff`
}

export function scopeFilter(column, scope, options = {}) {
  const own = canonScope(scope)
  const list = options.sharedOnly ? ['shared'] : visibleScopes(own)
  const base = list.length === 1
    ? { sql: `${column} = ?`, params: list }
    : { sql: `${column} IN (${list.map(() => '?').join(', ')})`, params: list }
  const prefixes = options.sharedOnly ? [] : visiblePrefixes(own)
  if (!prefixes.length) return base
  // 匿名档（qq:anon-*）是认不出会话时的落脚点，谁的可见列表里都没有它 ——
  // 只写不读等于黑洞：写进去了，本人再也看不见（REVIEW-152 第六轮）。
  // 只有「当面/面板」兜底看得见：那是最像本人的那一档，别处一律不给。
  // 用区间而不是 LIKE 'qq:anon-%'：LIKE 吃不到索引，整条查询退成全表扫
  // （REVIEW-153 第九轮实测：3004 条 SCAN 3.88ms → MULTI-INDEX OR 3.43ms）。
  // 上界用 prefixEnd：`>= 前缀` 且 `< 前缀+\uffff`，等于「以它开头的都在里面」，
  // 不依赖末字符恰好是 '-'（REVIEW-155 验收第五条 ②）。
  const ranges = prefixes.map((prefix) => `(${column} >= '${prefix}' AND ${column} < '${prefixEnd(prefix)}')`)
  return { sql: `(${base.sql} OR ${ranges.join(' OR ')})`, params: base.params }
}

/**
 * 写的时候能「接管」哪些档 —— 同键撞车的判定用。
 *
 * - 自己的档：当然。
 * - `gui` 还能接管 `shared`：当面说话的人就是他本人，共用层那条事实本来就该由他改。
 *   不接管的话，GUI 里把同一件事再说一遍，卡片里会并排出现「阿甲」和「阿乙」两个版本
 *   （REVIEW-150 第四、六轮实测）。
 * - `qq:<号>` / `group:<群号>` 只管自己那一档：老桶已经读不到了，再让它们接管
 *   等于把别人的旧账顶掉之后自己还看不见。
 */
export function ownScopes(scope) {
  const own = canonScope(scope)
  if (own === 'shared' || own === 'qq') return [own]
  if (own === 'gui') return ['gui', 'shared']
  return [own]
}

/** 给日志、面板用的一句话。 */
export function scopeLabel(scope) {
  const own = canonScope(scope)
  if (isShared(own)) return '共用的'
  if (own === 'gui') return '当面'
  if (own === 'qq') return 'QQ（老的）'
  const qq = /^qq:(\d+)$/.exec(own)
  if (qq) return `QQ ${qq[1]}`
  const group = /^group:(\d+)$/.exec(own)
  if (group) return `群 ${group[1]}`
  return own
}
