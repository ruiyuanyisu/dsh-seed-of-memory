/**
 * Seed of Memory — settings panel.
 *
 * Read-only overview (mood, beliefs, recent emotions, stats) plus two small
 * writes: mark a belief contested / restore it, forget a memory by id.
 * Everything goes through same-origin fetch to the host routes registered by
 * lib/index.js; no tokens are stored in the page.
 */
window.__ModuleLoader__.load({
  id: 'dsh-seed-of-memory',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const API = '/dsh-seed-of-memory'

    const CSS = `
.som-panel{display:flex;flex-direction:column;gap:14px;padding:4px 2px;font-size:13px;line-height:1.55}
.som-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.som-title{font-size:15px;font-weight:600}
.som-sub{opacity:.6;font-size:12px}
.som-card{border:1px solid rgba(127,127,127,.25);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.som-mood{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.som-mood-label{font-size:22px;font-weight:600}
.som-metrics{display:flex;gap:14px;font-variant-numeric:tabular-nums;opacity:.85}
.som-cause{opacity:.65;font-size:12px;max-width:52ch}
.som-spark{width:100%;height:56px;display:block}
.som-row{display:flex;gap:8px;align-items:flex-start;padding:7px 0;border-top:1px solid rgba(127,127,127,.16)}
.som-row:first-of-type{border-top:0}
.som-claim{flex:1;min-width:0}
.som-badge{font-size:11px;padding:1px 6px;border-radius:999px;border:1px solid rgba(127,127,127,.35);opacity:.8;white-space:nowrap}
.som-badge.contested{opacity:1;border-color:rgba(230,160,60,.6)}
.som-bar{height:4px;border-radius:2px;background:rgba(127,127,127,.22);overflow:hidden;margin-top:5px}
.som-bar>i{display:block;height:100%;background:rgba(90,170,255,.75)}
.som-btn{font-size:12px;padding:2px 8px;border-radius:6px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;cursor:pointer}
.som-btn:hover{background:rgba(127,127,127,.14)}
.som-empty{opacity:.55;font-size:12px}
.som-error{color:#e0655b;font-size:12px}
.som-foot{display:flex;justify-content:space-between;align-items:center;gap:12px;opacity:.7;font-size:12px}
.som-guide{font-size:13px;line-height:1.65;max-height:62vh;overflow:auto;padding-right:6px}
.som-guide-h1,.som-guide-h2{font-size:14px;margin:14px 0 6px;font-weight:600}
.som-guide-h3{font-size:13px;margin:10px 0 4px;font-weight:600;opacity:.85}
.som-guide-p{margin:4px 0}
.som-guide-list{margin:4px 0 4px 18px;padding:0}
.som-guide-code{background:rgba(0,0,0,.07);padding:1px 4px;border-radius:4px;font-size:12px}
.som-guide-pre{background:rgba(0,0,0,.06);padding:8px 10px;border-radius:8px;font-size:12px;overflow:auto;white-space:pre-wrap}
.som-tabs{display:flex;gap:6px}
.som-tab{font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;cursor:pointer;opacity:.7}
.som-tab.som-on{opacity:1;border-color:rgba(90,170,255,.65);background:rgba(90,170,255,.12)}
.som-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.som-input,.som-textarea{font:inherit;color:inherit;background:transparent;border:1px solid rgba(127,127,127,.35);border-radius:7px;padding:4px 8px}
.som-input{min-width:180px;flex:1}
.som-textarea{width:100%;min-height:190px;resize:vertical;line-height:1.55;font-family:inherit}
.som-tag{font-size:11px;opacity:.6;white-space:nowrap}
.som-danger{color:#e0655b}
.som-badge.som-ok{opacity:1;border-color:rgba(90,200,120,.65);color:#7ed39a}
.som-log{display:flex;flex-direction:column;gap:4px;font-family:ui-monospace,Consolas,monospace;font-size:11px}
.som-logline{opacity:.85;white-space:pre-wrap;word-break:break-word}
.som-friend{border:1px solid rgba(127,127,127,.22);border-radius:9px;padding:10px 12px;display:flex;flex-direction:column;gap:1px;background:rgba(127,127,127,.035)}
.som-friend-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:5px}
.som-friend-name{font-weight:600;font-size:14px}
.som-friend-who{opacity:.55;font-size:11.5px;margin-left:7px}
.som-field{display:flex;gap:10px;align-items:baseline;min-height:24px}
.som-field-k{flex:0 0 58px;opacity:.45;font-size:12px;text-align:right}
.som-field-v{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word;cursor:pointer;border-radius:5px;padding:1px 4px;margin-left:-4px}
.som-field-v:hover{background:rgba(127,127,127,.12)}
.som-field-v.som-blank{opacity:.32;font-style:italic}
.som-field .som-input{min-width:0}
.som-newblock{border-top:1px dashed rgba(127,127,127,.28);padding-top:10px;display:flex;flex-direction:column;gap:6px}
.som-select{font:inherit;font-size:12px;color:inherit;background:transparent;border:1px solid rgba(127,127,127,.35);border-radius:7px;padding:4px 6px}
.som-select option{background:Canvas;color:CanvasText}
.som-peerhint{font-size:11px;opacity:.45;font-family:ui-monospace,Consolas,monospace}
.som-late{color:#e0655b}
.som-warn{color:#e0a13c}
.som-qline{font-size:12.5px;opacity:.75;line-height:1.6;margin:-2px 0 6px}
.som-curve{width:100%;height:132px;display:block}
.som-legend{display:flex;gap:14px;font-size:11px;opacity:.6;margin-top:2px}
.som-legend>i{display:inline-block;width:14px;height:2px;vertical-align:middle;margin-right:5px;border-radius:2px}
.som-qbar{display:flex;align-items:center;gap:9px;padding:3px 0;font-size:12px}
.som-qbar-k{flex:0 0 52px;opacity:.5;text-align:right}
.som-qbar-track{flex:1;height:6px;border-radius:3px;background:rgba(127,127,127,.18);overflow:hidden}
.som-qbar-fill{display:block;height:100%;border-radius:3px;background:rgba(90,170,255,.75);transition:width .25s}
.som-qbar-fill.warm{background:rgba(230,140,110,.8)}
.som-qbar-fill.cool{background:rgba(120,210,160,.75)}
.som-qbar-v{flex:0 0 30px;text-align:right;font-variant-numeric:tabular-nums;opacity:.7}
.som-bar-gap{height:7px;border-top:1px dashed rgba(127,127,127,.2);margin:3px 0 7px}
    .som-qbar-fill.good{background:rgba(120,210,160,.75)}
    .som-daygrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.som-daycell{border:1px solid rgba(127,127,127,.18);border-radius:8px;padding:7px 8px}
.som-daycell>b{display:block;font-size:16px;font-variant-numeric:tabular-nums;font-weight:600}
.som-daycell>span{font-size:11px;opacity:.55}
`

    async function getJson(path, init) {
      const response = await fetch(API + path, { credentials: 'same-origin', ...init })
      if (!response.ok) {
        let detail = ''
        try {
          detail = (await response.json()).error || ''
        } catch {}
        throw new Error(`HTTP ${response.status}${detail ? ' · ' + detail : ''}`)
      }
      return response.json()
    }

    function when(ts) {
      if (!ts) return ''
      const diff = Date.now() - ts
      if (diff < 60_000) return '刚刚'
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
      return new Date(ts).toLocaleDateString()
    }

    function Spark({ emotions }) {
      const points = emotions.slice().reverse()
      if (points.length < 2) return h('div', { className: 'som-empty' }, '还没有足够的情绪点画曲线。')
      const w = 320
      const hgt = 56
      const pad = 4
      const step = (w - pad * 2) / (points.length - 1)
      const y = (v) => pad + ((1 - (v + 1) / 2) * (hgt - pad * 2))
      const line = points.map((p, i) => `${pad + i * step},${y(Number(p.valence))}`).join(' ')
      const zero = y(0)
      return h(
        'svg',
        { className: 'som-spark', viewBox: `0 0 ${w} ${hgt}`, preserveAspectRatio: 'none' },
        h('line', { x1: pad, y1: zero, x2: w - pad, y2: zero, stroke: 'rgba(127,127,127,.28)', strokeWidth: '1' }),
        h('polyline', { points: line, fill: 'none', stroke: 'rgba(90,170,255,.85)', strokeWidth: '1.6', strokeLinejoin: 'round' }),
        points.map((p, i) =>
          h('circle', {
            key: p.id,
            cx: pad + i * step,
            cy: y(Number(p.valence)),
            r: 1.8,
            fill: Number(p.valence) >= 0 ? 'rgba(120,210,150,.9)' : 'rgba(230,120,110,.9)',
          })
        )
      )
    }

    function BeliefRow({ belief, onStatus }) {
      const confidence = Math.max(0, Math.min(1, Number(belief.confidence) || 0))
      return h(
        'div',
        { className: 'som-row' },
        h(
          'div',
          { className: 'som-claim' },
          h('div', null, belief.claim),
          h(
            'div',
            { className: 'som-meta', style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 } },
            h('span', { className: 'som-badge' }, belief.status === 'contested' ? '存疑' : '确信'),
            h('span', { className: 'som-badge' }, `置信 ${confidence.toFixed(2)}`),
            belief.fact_key ? h('span', { className: 'som-badge' }, belief.fact_key) : null
          ),
          h('div', { className: 'som-bar' }, h('i', { style: { width: `${confidence * 100}%` } }))
        ),
        h(
          'button',
          {
            className: 'som-btn',
            onClick: () => onStatus(belief, belief.status === 'contested' ? 'active' : 'contested'),
          },
          belief.status === 'contested' ? '恢复' : '存疑'
        )
      )
    }

    const LAYER_LABEL = { persona: '身份', semantic: '长期', episodic: '经历', buffer: '临时' }
    const TIER_LABEL = { working: '工作记忆', short: '短期', long: '长期' }
    const SOURCE_LABEL = { 'user-said': '你说的', inferred: '推断', rule: '规则', import: '导入' }
    const CUE_LABEL = {
      remember: '记住',
      habit: '习惯',
      preference: '偏好',
      agreement: '约定',
      identity: '身份',
      boundary: '边界',
      emotion: '情绪',
      new: '值得看',
    }
    const layerLabel = (value) => LAYER_LABEL[value] ?? value
    const tierLabel = (value) => TIER_LABEL[value] ?? value
    const sourceLabel = (value) => SOURCE_LABEL[value] ?? value

    function LayerTag({ layer }) {
      return h('span', { className: 'som-tag' }, layerLabel(layer))
    }

    function BeliefsView({ state, reload }) {
      const [status, setStatus] = useState('all')
      const [rows, setRows] = useState(null)
      const [error, setError] = useState('')
      const [claim, setClaim] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback(async (next = status) => {
        setBusy(true)
        setError('')
        try {
          const data = await getJson(`/beliefs?status=${encodeURIComponent(next)}&limit=300`)
          setRows(data.rows ?? [])
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [status])

      useEffect(() => {
        load(status)
      }, [status, load])

      const flip = useCallback(
        async (belief, next) => {
          try {
            await getJson('/belief', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: belief.id, status: next }),
            })
            await load(status)
            reload()
          } catch (err) {
            setError(String(err?.message ?? err))
          }
        },
        [load, status, reload]
      )

      const add = useCallback(async () => {
        const text = claim.trim()
        if (!text) return
        try {
          await getJson('/believe', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ claim: text, source: 'user-said' }),
          })
          setClaim('')
          await load(status)
          reload()
        } catch (err) {
          setError(String(err?.message ?? err))
        }
      }, [claim, load, status, reload])

      const filters = [
        ['all', '全部'],
        ['active', '活跃'],
        ['contested', '存疑'],
        ['retired', '已退休'],
      ]

      return h(
        'div',
        { className: 'som-card' },
        h(
          'div',
          { className: 'som-toolbar' },
          ...filters.map(([id, label]) =>
            h(
              'button',
              { key: id, className: 'som-tab' + (status === id ? ' som-on' : ''), onClick: () => setStatus(id) },
              label
            )
          ),
          h('span', { className: 'som-sub' }, busy ? '读取中…' : `${(rows ?? []).length} 条`)
        ),
        error ? h('div', { className: 'som-error' }, error) : null,
        h(
          'div',
          { className: 'som-toolbar', style: { marginTop: 8 } },
          h('input', {
            className: 'som-input',
            placeholder: '记下一条新的判断（用第三人称写「他」，例如：他怕冷）',
            value: claim,
            onChange: (e) => setClaim(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter') add()
            },
          }),
          h('button', { className: 'som-btn', onClick: add, disabled: !claim.trim() }, '记下')
        ),
        (rows ?? []).length
          ? rows.map((belief) =>
              h(
                'div',
                { key: belief.id, className: 'som-row' },
                h(
                  'div',
                  { className: 'som-claim' },
                  h('div', null, belief.claim),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' } },
                    h('span', { className: 'som-badge' + (belief.status === 'contested' ? ' contested' : '') }, belief.status === 'contested' ? '存疑' : belief.status === 'retired' ? '退休' : '确信'),
                    h('span', { className: 'som-badge' }, `置信 ${Number(belief.confidence ?? 0).toFixed(2)}`),
                    belief.fact_key ? h('span', { className: 'som-badge' }, belief.fact_key) : null,
                    belief.source ? h('span', { className: 'som-tag' }, belief.source) : null,
                    (belief.evidence ?? []).length ? h('span', { className: 'som-tag' }, `证据 ${(belief.evidence ?? []).length}`) : null
                  ),
                  h('div', { className: 'som-bar' }, h('i', { style: { width: `${Math.max(0, Math.min(1, Number(belief.confidence) || 0)) * 100}%` } }))
                ),
                belief.status === 'retired'
                  ? h('span', { className: 'som-tag' }, '只读')
                  : h(
                      'button',
                      {
                        className: 'som-btn',
                        onClick: () => flip(belief, belief.status === 'contested' ? 'active' : 'contested'),
                      },
                      belief.status === 'contested' ? '恢复' : '存疑'
                    )
              )
            )
          : h('div', { className: 'som-empty' }, '这个范围里还没有认知条目。')
      )
    }

    function EmotionsView() {
      const [data, setData] = useState(null)
      const [days, setDays] = useState(30)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        let alive = true
        setBusy(true)
        setError('')
        getJson(`/emotions?days=${days}&limit=200`)
          .then((next) => {
            if (alive) setData(next)
          })
          .catch((err) => {
            if (alive) setError(String(err?.message ?? err))
          })
          .finally(() => {
            if (alive) setBusy(false)
          })
        return () => {
          alive = false
        }
      }, [days])

      const rows = data?.rows ?? []
      const byLabel = data?.byLabel ?? []
      const byDay = (data?.byDay ?? []).map((row) => ({ id: row.day, valence: row.valence }))
      const maxN = byLabel.reduce((acc, row) => Math.max(acc, row.n), 0) || 1

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'som-card' },
          h(
            'div',
            { className: 'som-toolbar' },
            ...[7, 30, 90].map((n) =>
              h(
                'button',
                { key: n, className: 'som-tab' + (days === n ? ' som-on' : ''), onClick: () => setDays(n) },
                `${n} 天`
              )
            ),
            h('span', { className: 'som-sub' }, busy ? '读取中…' : `${rows.length} 条情绪记录`)
          ),
          error ? h('div', { className: 'som-error' }, error) : null,
          h(Spark, { emotions: rows.slice(0, 60) }),
          h('div', { className: 'som-sub' }, byDay.length ? '按天平均愉悦度（最左最早）' : '这段时间还没有记录。')
        ),
        h(
          'div',
          { className: 'som-card' },
          h('div', { className: 'som-sub' }, '对你的情感（慢变量，基线附近浮动，30 天半衰期回落）'),
          (data?.affects ?? []).length
            ? data.affects.map((row) =>
                h(
                  'div',
                  { key: row.kind, className: 'som-row' },
                  h(
                    'div',
                    { className: 'som-claim' },
                    h('div', null, row.kind),
                    h('div', { className: 'som-bar' }, h('i', { style: { width: `${Math.round(Number(row.strength) * 100)}%` } }))
                  ),
                  h('span', { className: 'som-badge' }, `${Number(row.strength).toFixed(2)}`),
                  h('span', { className: 'som-sub' }, `基线 ${Number(row.base).toFixed(2)}`)
                )
              )
            : h('div', { className: 'som-empty' }, '还没有记录。')
        ),
        h(
          'div',
          { className: 'som-card' },
          h('div', { className: 'som-sub' }, '情绪分布'),
          byLabel.length
            ? byLabel.map((row) =>
                h(
                  'div',
                  { key: row.label, className: 'som-row' },
                  h('div', { className: 'som-claim' }, h('div', null, row.label), h('div', { className: 'som-bar' }, h('i', { style: { width: `${(row.n / maxN) * 100}%` } }))),
                  h('span', { className: 'som-badge' }, `${row.n} 次`),
                  h('span', { className: 'som-badge' }, `${Number(row.valence) >= 0 ? '+' : ''}${Number(row.valence).toFixed(2)}`)
                )
              )
            : h('div', { className: 'som-empty' }, '还没有分布数据。')
        ),
        h(
          'div',
          { className: 'som-card' },
          h('div', { className: 'som-sub' }, '最近的情绪与原因'),
          rows.length
            ? rows.slice(0, 40).map((row) =>
                h(
                  'div',
                  { key: row.id, className: 'som-row' },
                  h('div', null, row.label),
                  h('div', { className: 'som-claim' }, row.cause ? h('span', { className: 'som-cause' }, row.cause) : h('span', { className: 'som-sub' }, '（没有记录原因）')),
                  h('span', { className: 'som-badge' }, `强度 ${Number(row.intensity).toFixed(2)}`),
                  h('span', { className: 'som-sub' }, when(row.at))
                )
              )
            : h('div', { className: 'som-empty' }, '还没有情绪记录。用 seed_feel 或 /seed feel 写。')
        )
      )
    }

    function MemoryView() {
      const [layer, setLayer] = useState('')
      const [q, setQ] = useState('')
      const [rows, setRows] = useState([])
      const [captures, setCaptures] = useState([])
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      const loadCaptures = useCallback(async () => {
        try {
          const data = await getJson('/captures?limit=8')
          setCaptures(data.rows ?? [])
        } catch {
          setCaptures([])
        }
      }, [])

      useEffect(() => {
        loadCaptures()
      }, [loadCaptures])

      const load = useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          const params = new URLSearchParams()
          if (layer) params.set('layer', layer)
          if (q.trim()) params.set('q', q.trim())
          params.set('limit', '120')
          const data = await getJson('/memories?' + params.toString())
          setRows(data.rows ?? [])
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [layer, q])

      useEffect(() => {
        load()
      }, [load])

      const decideCapture = useCallback(
        async (row, action) => {
          try {
            await getJson('/capture', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: row.id, action, layer: 'semantic' }),
            })
            await loadCaptures()
            if (action === 'accept') await load()
          } catch (err) {
            setError(String(err?.message ?? err))
          }
        },
        [load, loadCaptures]
      )

      const forget = useCallback(
        async (row) => {
          if (!window.confirm(`删除这条记忆？\n\n${row.text}`)) return
          try {
            await getJson('/forget', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: row.id }),
            })
            await load()
          } catch (err) {
            setError(String(err?.message ?? err))
          }
        },
        [load]
      )

      const chips = [
        ['', '全部'],
        ['persona', '身份'],
        ['semantic', '长期'],
        ['episodic', '经历'],
        ['buffer', '临时'],
      ]

      const LAYER_HINT = {
        '': '四层合起来是我记得的东西：身份 / 长期 / 经历 / 临时。点上面的小按钮，只看一层。',
        persona: '身份：我不会变的那几样——我叫什么、你怎么叫我、说话的调子。它要是也跟着「发生了一件事」被覆盖，我就不叫小忆了。',
        semantic: '长期：跟你有关、隔一个月也还成立的事。喜欢什么、怕什么。',
        episodic: '经历：发生过的事，带着日子。像日记，越攒越多，翻的时候按时间找。',
        buffer: '临时：手头正在办的。过两天就没用了。',
      }

      return h(
        'div',
        { className: 'som-card' },
        h(
          'div',
          { className: 'som-toolbar' },
          ...chips.map(([value, label]) =>
            h(
              'button',
              {
                key: value || 'all',
                className: 'som-tab' + (layer === value ? ' som-on' : ''),
                onClick: () => setLayer(value),
              },
              label
            )
          ),
          h('input', {
            className: 'som-input',
            placeholder: '搜索记忆（回车）',
            value: q,
            onChange: (e) => setQ(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter') load()
            },
          }),
          h('button', { className: 'som-btn', onClick: load, disabled: busy }, busy ? '查询中…' : '搜索')
        ),
        h('div', { className: 'som-sub', style: { marginTop: -2, marginBottom: 10 } }, LAYER_HINT[layer] ?? LAYER_HINT['']),
        error ? h('div', { className: 'som-error' }, error) : null,
        captures.length
          ? h(
              'div',
              { className: 'som-card', style: { marginBottom: 10 } },
              h('div', { className: 'som-title', style: { fontSize: 13, marginBottom: 6 } }, '待记（从你的话里挑出来的候选）'),
              captures.map((row) =>
                h(
                  'div',
                  { key: row.id, className: 'som-row' },
                  h(
                    'div',
                    { className: 'som-claim' },
                    h('div', null, row.text),
                    h('div', { className: 'som-meta' }, h('span', { className: 'som-tag' }, CUE_LABEL[row.cue] ?? row.cue))
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 6 } },
                    h('button', { className: 'som-btn', onClick: () => decideCapture(row, 'accept') }, '记下'),
                    h('button', { className: 'som-btn som-muted', onClick: () => decideCapture(row, 'dismiss') }, '不用')
                  )
                )
              )
            )
          : null,
        rows.length
          ? rows.map((row) =>
              h(
                'div',
                { key: row.id, className: 'som-row' },
                h(
                  'div',
                  { className: 'som-claim' },
                  h('div', null, row.text),
                  h(
                    'div',
                    { className: 'som-meta', style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' } },
                    h(LayerTag, { layer: row.layer }),
                    row.tier ? h('span', { className: 'som-badge' }, tierLabel(row.tier)) : null,
                    row.emotion ? h('span', { className: 'som-badge' }, row.emotion) : null,
                    h('span', { className: 'som-badge' }, `重要 ${Number(row.importance).toFixed(2)}`),
                    h('span', { className: 'som-badge' }, sourceLabel(row.source)),
                    h('span', { className: 'som-tag' }, when(row.recordedAt))
                  )
                ),
                h('button', { className: 'som-btn som-danger', onClick: () => forget(row) }, '删除')
              )
            )
          : h('div', { className: 'som-empty' }, q ? '没有匹配的记忆。' : '这一层还没有条目。')
      )
    }

    const ROOT_SECTIONS = [
      ['anchors', '根', '名字与善良。工具不能改，只有这里能改；改之前想清楚。'],
      ['self', '我是谁', '我自己写的一页，可以慢慢长。'],
      ['us', '我们之间', '称呼、约定、重要日期，一条一行。'],
    ]

    function RootView() {
      const [drafts, setDrafts] = useState({ anchors: '', self: '', us: '' })
      const [bytes, setBytes] = useState({})
      const [error, setError] = useState('')
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          const data = await getJson('/root')
          setDrafts({ anchors: data.anchors ?? '', self: data.self ?? '', us: data.us ?? '' })
          setBytes(data.bytes ?? {})
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const save = useCallback(
        async (which) => {
          setNote('')
          try {
            const data = await getJson('/root', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ which, text: drafts[which] }),
            })
            setDrafts({ anchors: data.anchors ?? '', self: data.self ?? '', us: data.us ?? '' })
            setBytes(data.bytes ?? {})
            const label = ROOT_SECTIONS.find((row) => row[0] === which)?.[1] ?? which
            setNote(`「${label}」已保存`)
          } catch (err) {
            setError(String(err?.message ?? err))
          }
        },
        [drafts]
      )

      const byteCount = (text) => new TextEncoder().encode(text || '').length

      return h(
        'div',
        { className: 'som-card' },
        h('div', { className: 'som-sub' }, '身份根：每轮注入在最前面，不衰减、不被删除。改完下一轮生效；换会话/换模型也读同一份。'),
        error ? h('div', { className: 'som-error' }, error) : null,
        note ? h('div', { className: 'som-sub' }, note) : null,
        ...ROOT_SECTIONS.map(([key, label, hint], index) =>
          h(
            'div',
            { key, style: { marginTop: index ? 10 : 0 } },
            h(
              'div',
              { className: 'som-sub' },
              `${label} · ${byteCount(drafts[key])} 字节${bytes[key] ? `（已存 ${bytes[key]}）` : ''}`
            ),
            h('textarea', {
              className: 'som-textarea',
              value: drafts[key],
              onChange: (e) => setDrafts({ ...drafts, [key]: e.target.value }),
            }),
            h(
              'div',
              { className: 'som-toolbar' },
              h('button', { className: 'som-btn', onClick: () => save(key), disabled: busy }, `保存「${label}」`),
              index === 0
                ? h('button', { className: 'som-btn', onClick: load, disabled: busy }, busy ? '读取中…' : '重新读取')
                : null
            ),
            h('div', { className: 'som-sub' }, hint)
          )
        ),
        h('div', { className: 'som-sub', style: { marginTop: 8 } }, '上限 8000 字节；根（名字、善良）要改请想清楚。')
      )
    }

    function PersonaView() {
      const [data, setData] = useState(null)
      const [statement, setStatement] = useState('')
      const [keywords, setKeywords] = useState('')
      const [name, setName] = useState('')
      const [habitText, setHabitText] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          const [next, style] = await Promise.all([getJson('/persona'), getJson('/style')])
          setData({ ...next, style })
          setStatement(next.aspiration?.statement ?? '')
          setKeywords((next.aspiration?.keywords ?? []).join('、'))
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const saveAspire = useCallback(async () => {
        try {
          await getJson('/aspire', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              statement: statement.trim(),
              keywords: keywords
                .split(/[、,，\s]+/)
                .map((item) => item.trim())
                .filter(Boolean),
            }),
          })
          await load()
        } catch (err) {
          setError(String(err?.message ?? err))
        }
      }, [statement, keywords, load])

      const bump = useCallback(
        async (trait, delta) => {
          try {
            await getJson('/trait', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: trait.name, delta }),
            })
            await load()
          } catch (err) {
            setError(String(err?.message ?? err))
          }
        },
        [load]
      )

      const add = useCallback(async () => {
        const text = name.trim()
        if (!text) return
        try {
          await getJson('/trait', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: text }),
          })
          setName('')
          await load()
        } catch (err) {
          setError(String(err?.message ?? err))
        }
      }, [name, load])

      const bumpHabit = useCallback(
        async (habit, delta) => {
          try {
            await getJson('/habit', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ statement: habit.statement, key: habit.key, delta }),
            })
            await load()
          } catch (err) {
            setError(String(err?.message ?? err))
          }
        },
        [load]
      )

      const addHabit = useCallback(async () => {
        const text = habitText.trim()
        if (!text) return
        try {
          await getJson('/habit', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ statement: text }),
          })
          setHabitText('')
          await load()
        } catch (err) {
          setError(String(err?.message ?? err))
        }
      }, [habitText, load])

      const aspirations = data?.aspiration
      const traits = data?.traits ?? []
      const habits = (data?.style?.habits ?? []).filter((habit) => habit.status !== 'retired')
      const styleText = data?.style?.line ?? ''
      const fit = data?.fit ?? { score: 0, parts: [], gaps: [] }
      const arrow = (trend) => (trend === 'up' ? '↗' : trend === 'down' ? '↘' : '→')

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'som-card' },
          h('div', { className: 'som-sub' }, '理想（想成为什么样的人）'),
          h(
            'div',
            { className: 'som-toolbar', style: { marginTop: 4 } },
            h('input', {
              className: 'som-input',
              value: statement,
              placeholder: '一句短话，例如「可爱温柔带点任性」',
              onChange: (e) => setStatement(e.target.value),
            }),
            h('button', { className: 'som-btn', onClick: saveAspire, disabled: busy || !statement.trim() }, '保存')
          ),
          h(
            'div',
            { className: 'som-toolbar', style: { marginTop: 6 } },
            h('input', {
              className: 'som-input',
              value: keywords,
              placeholder: '关键词，用顿号分开：可爱、温柔、任性',
              onChange: (e) => setKeywords(e.target.value),
            })
          ),
          aspirations?.statement
            ? h(
                'div',
                { className: 'som-sub', style: { marginTop: 6 } },
                `当前理想：${aspirations.statement} · 拟合度 ${(fit.score * 100).toFixed(0)}%` +
                  (fit.gaps.length ? ` · 还差：${fit.gaps.join('、')}` : '')
              )
            : null,
          error ? h('div', { className: 'som-error' }, error) : null
        ),
        h(
          'div',
          { className: 'som-card' },
          h('div', { className: 'som-sub' }, `正在长成的特质（${traits.filter((trait) => trait.status === 'active').length} 个稳定 / ${traits.filter((trait) => trait.status === 'candidate').length} 个候选）`),
          traits.length
            ? traits
                .filter((trait) => trait.status !== 'retired')
                .map((trait) =>
                  h(
                    'div',
                    { key: trait.id, className: 'som-row' },
                    h(
                      'div',
                      { className: 'som-claim' },
                      h(
                        'div',
                        { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                        h('span', null, trait.name),
                        h('span', { className: 'som-tag' }, arrow(trait.trend)),
                        h('span', { className: 'som-badge' }, trait.strength.toFixed(2)),
                        h('span', { className: 'som-tag' }, trait.status === 'active' ? '稳定' : '候选')
                      ),
                      trait.statement ? h('div', { className: 'som-cause' }, trait.statement) : null,
                      h('div', { className: 'som-bar' }, h('i', { style: { width: `${trait.strength * 100}%` } })),
                      h('div', { className: 'som-tag', style: { marginTop: 4 } }, `证据 ${trait.evidence.length}${trait.counter.length ? ` · 反例 ${trait.counter.length}` : ''}`)
                    ),
                    h(
                      'div',
                      { style: { display: 'flex', gap: 4 } },
                      h('button', { className: 'som-btn', title: '多一次证据', onClick: () => bump(trait, 0.05) }, '＋'),
                      h('button', { className: 'som-btn som-danger', title: '记一次反例', onClick: () => bump(trait, -0.05) }, '－')
                    )
                  )
                )
            : h('div', { className: 'som-empty' }, '还没有特质。用 seed_trait 或下面手动加一个。')
        ),
        h(
          'div',
          { className: 'som-card' },
          h('div', { className: 'som-sub' }, `说话习惯（默认持续学习 · ${habits.filter((habit) => habit.status === 'active').length} 条已定型）`),
          styleText ? h('div', { className: 'som-cause', style: { marginTop: 4 } }, `当前注入：${styleText}`) : null,
          habits.length
            ? habits.map((habit) =>
                h(
                  'div',
                  { key: habit.id, className: 'som-row' },
                  h(
                    'div',
                    { className: 'som-claim' },
                    h('div', null, habit.statement),
                    h('div', { className: 'som-bar' }, h('i', { style: { width: `${habit.strength * 100}%` } })),
                    h(
                      'div',
                      { className: 'som-tag', style: { marginTop: 4 } },
                      `${habit.status === 'active' ? '已定型' : '在学'} ${habit.strength.toFixed(2)} · 证据 ${habit.evidence.length}${habit.counter.length ? ` · 反例 ${habit.counter.length}` : ''}`
                    )
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 4 } },
                    h('button', { className: 'som-btn', title: '多一次证据', onClick: () => bumpHabit(habit, 0.05) }, '＋'),
                    h('button', { className: 'som-btn som-danger', title: '记一次反例', onClick: () => bumpHabit(habit, -0.05) }, '－')
                  )
                )
              )
            : h('div', { className: 'som-empty' }, '还没有说话习惯。你纠正我的表达方式时，会自动记一条。'),
          h(
            'div',
            { className: 'som-toolbar', style: { marginTop: 8 } },
            h('input', {
              className: 'som-input',
              placeholder: '加一条说话习惯，例如「先接一句，再展开」',
              value: habitText,
              onChange: (e) => setHabitText(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') addHabit()
              },
            }),
            h('button', { className: 'som-btn', onClick: addHabit, disabled: !habitText.trim() }, '记下')
          ),
          h('div', { className: 'som-sub', style: { marginTop: 6 } }, '每日最多 +0.15；到 0.40 会常驻在人格卡里；反例会扣分。')
        ),
        h(
          'div',
          { className: 'som-card' },
          h(
            'div',
            { className: 'som-toolbar' },
            h('input', {
              className: 'som-input',
              placeholder: '加一个特质名，例如「耐心」',
              value: name,
              onChange: (e) => setName(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') add()
              },
            }),
            h('button', { className: 'som-btn', onClick: add, disabled: !name.trim() }, '记下')
          ),
          h('div', { className: 'som-sub', style: { marginTop: 6 } }, '强度每天最多 +0.10；反例会扣分；90 天没有新证据会慢慢回落。')
        )
      )
    }

    function EmbeddingView() {
      const [data, setData] = useState(null)
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState('')
      const [error, setError] = useState('')

      const load = useCallback(async () => {
        try {
          setData(await getJson('/embedding'))
          setError('')
        } catch (err) {
          setError(String(err?.message ?? err))
        }
      }, [])

      useEffect(() => {
        load()
        const timer = setInterval(load, 5000)
        return () => clearInterval(timer)
      }, [load])

      const call = useCallback(
        async (label, path, body) => {
          setBusy(label)
          setNote('')
          setError('')
          try {
            const result = await getJson(path, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body || {}),
            })
            // 有些动作（重建索引）是一次请求里补一批，剩下的交给后台；把剩多少直接说出来，
            // 不然「完成」两个字会让人以为全好了。
            const left = Number(result?.remaining)
            const tail =
              Number.isFinite(left) && left > 0
                ? `，已补 ${Number(result?.embedded) || 0} 条，还剩 ${left} 条（后台每 20 秒接着补，不用管）`
                : ''
            setNote(`${label}：${result?.ok === false ? result.error : '完成'}${tail}`)
            await load()
          } catch (err) {
            setError(String(err?.message ?? err))
          } finally {
            setBusy('')
          }
        },
        [load]
      )

      const installed = Boolean(data?.installed)
      const running = Boolean(data?.running)
      const scans = data?.scans || []
      const index = data?.index || {}
      const total = Number(index.total) || 0
      const indexed = Number(index.indexed) || 0
      const pending = Number(index.pending) || 0
      const coverage = total === 0 ? 100 : Math.round((indexed / total) * 100)

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'som-card' },
          h('div', { className: 'som-sub' }, '本地语义检索（可选）'),
          h(
            'div',
            { style: { display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0' } },
            h('span', { className: 'som-badge' }, installed ? '已安装' : '未安装'),
            h('span', { className: 'som-badge' }, running ? '运行中' : '已停止'),
            h('span', { className: 'som-badge' }, data?.model || 'bge-small-zh-v1.5'),
            h('span', { className: 'som-badge' }, `${data?.dimension || 512} 维`)
          ),
          h('div', { className: 'som-sub' }, `地址 ${data?.endpoint || 'http://127.0.0.1:11435'}`),
          h(
            'div',
            { className: 'som-sub' },
            `索引：${indexed}/${total} 条（${coverage}%）${pending ? ` · 待回填 ${pending}` : ' · 已补齐'}`
          ),
          h(
            'div',
            { className: 'som-sub' },
            data?.semanticEnabled === false
              ? '语义混合：已关闭（只用字面匹配）'
              : `语义混合：开启（向量权重 ${Math.round((Number(data?.semanticWeight) || 0.55) * 100)}%，无向量时自动退回字面匹配）`
          ),
          h(
            'div',
            { className: 'som-sub' },
            '装了它，检索会从「字面匹配」升级成「语义匹配」——换个说法也能找回来；不装也能用，只是容易漏。'
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
            installed
              ? h('button', { className: 'som-btn', disabled: running || Boolean(busy), onClick: () => call('启动', '/embedding/start') }, running ? '已运行' : '启动运行时')
              : null,
            installed
              ? h('button', { className: 'som-btn', disabled: !running || Boolean(busy), onClick: () => call('停止', '/embedding/stop') }, '停止')
              : null,
            installed
              ? h(
                  'button',
                  { className: 'som-btn', disabled: !running || Boolean(busy), onClick: () => call('重建索引', '/embedding/reindex') },
                  busy === '重建索引' ? '重建中…（先补一批，剩下的后台接着补）' : '重建索引'
                )
              : null,
            h('button', { className: 'som-btn', disabled: Boolean(busy), onClick: () => call('扫描', '/embedding/scan') }, '重新扫描安装包')
          )
        ),
        h(
          'div',
          { className: 'som-card' },
          h('div', { className: 'som-sub' }, `发现 ${scans.length} 个安装包`),
          scans.length === 0
            ? h('div', { className: 'som-sub' }, '把 seed-embed-runtime-*.zip 下载到「下载 / 桌面 / 文档」目录，几秒后这里会自动出现（默认会自动安装）。')
            : scans.map((item) =>
                h(
                  'div',
                  { key: item.path, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' } },
                  h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.name),
                  h('span', { className: 'som-sub' }, `${Math.round(item.bytes / 1024 / 1024)}MB`),
                  h('button', { className: 'som-btn', disabled: Boolean(busy), onClick: () => call('安装', '/embedding/install', { path: item.path }) }, '安装')
                )
              )
        ),
        note ? h('div', { className: 'som-sub', style: { padding: '4px 2px' } }, note) : null,
        error ? h('div', { className: 'som-error' }, error) : null
      )
    }

    function QqView() {
      const [state, setState] = useState(null)
      const [form, setForm] = useState(null)
      const [pro, setPro] = useState(null)
      const [onb, setOnb] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [proNote, setProNote] = useState('')

      const load = useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          const [next, proactive, voice, onboarding] = await Promise.all([
            getJson('/qq'),
            getJson('/qq/proactive').catch(() => null),
            getJson('/voice').catch(() => null),
            getJson('/qq/onboarding').catch(() => null),
          ])
          setState({ ...next, proactive, voice })
          setOnb(onboarding)
          setForm((prev) => prev ?? {
            wsUrl: next.config?.wsUrl ?? '',
            httpUrl: next.config?.httpUrl ?? '',
            accessToken: '',
            allowPrivate: (next.config?.allowPrivate ?? []).join(', '),
            allowGroups: (next.config?.allowGroups ?? []).join(', '),
            cwd: next.config?.cwd ?? '',
            ownerQQ: next.config?.ownerQQ ?? '',
            autoReply: next.config?.autoReply !== false,
            groupRequireAt: next.config?.groupRequireAt !== false,
            groupPolicy: next.config?.groupPolicy ?? 'smart',
            groupTopics: (next.config?.groupTopics ?? []).join(', '),
            groupMinGapSec: next.config?.groupMinGapSec ?? 120,
            groupMaxPerHour: next.config?.groupMaxPerHour ?? 8,
            groupMaxPerDay: next.config?.groupMaxPerDay ?? 60,
            groupQuietStart: next.config?.groupQuietStart ?? 0,
            groupQuietEnd: next.config?.groupQuietEnd ?? 7,
          })
          setPro((prev) => prev ?? {
            enabled: proactive?.config?.enabled !== false,
            voice: Boolean(proactive?.config?.voice),
            ownerQQ: proactive?.config?.ownerQQ ?? next.config?.ownerQQ ?? '',
            minIntervalHours: proactive?.config?.minIntervalHours ?? 4,
            maxPerDay: proactive?.config?.maxPerDay ?? 3,
            quietStart: proactive?.config?.quietStart ?? 23,
            quietEnd: proactive?.config?.quietEnd ?? 8,
          })
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const post = useCallback(
        async (path, body) => {
          setBusy(true)
          setError('')
          try {
            await getJson(path, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body ?? {}),
            })
            await load()
          } catch (err) {
            setError(String(err?.message ?? err))
          } finally {
            setBusy(false)
          }
        },
        [load]
      )

      const save = useCallback(() => {
        if (!form) return
        return post('/qq/config', {
          wsUrl: form.wsUrl,
          httpUrl: form.httpUrl,
          accessToken: form.accessToken || undefined,
          allowPrivate: String(form.allowPrivate || '').split(/[,，\s]+/).filter(Boolean),
          allowGroups: String(form.allowGroups || '').split(/[,，\s]+/).filter(Boolean),
          autoReply: form.autoReply !== false,
          ownerQQ: String(form.ownerQQ ?? ''),
          groupRequireAt: Boolean(form.groupRequireAt),
          groupPolicy: form.groupPolicy || 'smart',
          groupTopics: String(form.groupTopics || '').split(/[,，\s]+/).filter(Boolean),
          groupMinGapSec: Number(form.groupMinGapSec) || 120,
          groupMaxPerHour: Number(form.groupMaxPerHour) || 8,
          groupMaxPerDay: Number(form.groupMaxPerDay) || 60,
          groupQuietStart: Number(form.groupQuietStart) || 0,
          groupQuietEnd: Number(form.groupQuietEnd) || 0,
          cwd: form.cwd,
        })
      }, [form, post])

      const savePro = useCallback(async () => {
        if (!pro) return
        setBusy(true)
        setProNote('')
        try {
          await getJson('/qq/proactive', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              enabled: Boolean(pro.enabled),
              voice: Boolean(pro.voice),
              minIntervalHours: Number(pro.minIntervalHours) || 4,
              maxPerDay: Number(pro.maxPerDay) || 3,
              quietStart: Number(pro.quietStart) || 0,
              quietEnd: Number(pro.quietEnd) || 0,
              ownerQQ: String(pro.ownerQQ ?? ''),
            }),
          })
          setProNote('已保存。')
          await load()
        } catch (err) {
          setProNote('保存失败：' + String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [pro, load])

      const sayOnce = useCallback(async () => {
        setBusy(true)
        setProNote('')
        try {
          const result = await getJson('/qq/proactive/once', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ voice: Boolean(pro?.voice) }),
          })
          const r = result?.result
          setProNote(r?.sent ? `说出去了（${r.kind}）：${r.text}` : `没说：${r?.reason || '未知原因'}`)
          await load()
        } catch (err) {
          setProNote('发送失败：' + String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [pro, load])

      const status = state?.status
      const config = state?.config
      const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }))
      const voiceLabel = (mode) => ({ full: '能听也能说', 'voice-out': '能说话、听不见语音', 'voice-in': '能听、回文字', text: '纯文字模式' }[mode] ?? '还没探测')
      const refreshVoice = useCallback(async () => {
        setBusy(true)
        try {
          const voice = await getJson('/voice?refresh=1')
          setState((prev) => (prev ? { ...prev, voice } : prev))
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [])

      const checkConn = useCallback(async () => {
        setBusy(true)
        try {
          setOnb(await getJson('/qq/onboarding'))
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [])

      return h(
        'div',
        null,
        error ? h('div', { className: 'som-error' }, error) : null,
        h(
          'div',
          { className: 'som-card' },
          h(
            'div',
            { className: 'som-toolbar' },
            h('span', { className: 'som-badge' + (status?.connected ? ' som-ok' : '') }, status?.connected ? '已连接 SnowLuma' : status?.started ? '连接中…' : '未启动'),
            h('span', { className: 'som-sub' }, `账号 ${status?.selfId || config?.selfId || '—'} · 会话 ${status?.peers?.length ?? 0}`),
            h('button', { className: 'som-btn', onClick: load, disabled: busy }, busy ? '…' : '刷新'),
            h('button', { className: 'som-btn', onClick: () => post('/qq/start'), disabled: busy || status?.connected }, '连接'),
            h('button', { className: 'som-btn', onClick: () => post('/qq/stop'), disabled: busy || !status?.started }, '断开')
          ),
          h('div', { className: 'som-sub' }, '把 OneBot 11（SnowLuma / NapCat / Lagrange）接进来后，QQ 私聊/群聊会用一颗正常的 Agent 会话回复——根、记忆卡、人格与心情都在。Seed 自己就是桥；如果还跑着别的桥，先把它停掉，同一个账号只能有一个回话。')
        ),
        h(
          'div',
          { className: 'som-card' },
          h(
            'div',
            { className: 'som-toolbar' },
            h('span', { className: 'som-badge' + (onb?.next === 'done' ? ' som-ok' : '') }, onb?.next === 'done' ? 'QQ 已接好' : onb?.next ? `下一步：${(onb.steps ?? []).find((s) => s.id === onb.next)?.title ?? ''}` : '还没检测'),
            h('button', { className: 'som-btn', onClick: checkConn, disabled: busy }, busy ? '…' : '检测连接')
          ),
          h('div', { className: 'som-sub' }, '第一次接 QQ：先让桥跑起来，再按顺序做一遍就行。'),
          ...(onb?.steps ?? []).map((step) =>
            h('div', { className: 'som-sub', key: step.id }, `${step.done ? '✓' : '○'} ${step.title}${step.done ? '' : ` — ${step.hint}`}`)
          ),
          onb?.login
            ? h('div', { className: 'som-sub' }, `已登录：${onb.login.nickname || onb.login.user_id || 'QQ 账号'}`)
            : null,
          onb?.loginError ? h('div', { className: 'som-sub' }, `登录信息拿不到：${onb.loginError}`) : null,
          h('div', { className: 'som-sub' }, 'SnowLuma 解压后双击 launcher.bat；登录和 OneBot 设置都在 http://127.0.0.1:5099。')
        ),
        h(
          'div',
          { className: 'som-card' },
          h('div', { className: 'som-sub' }, '连接配置（保存后自动重连）'),
          h('input', { className: 'som-input', placeholder: 'ws://127.0.0.1:3001', value: form?.wsUrl ?? '', onChange: set('wsUrl') }),
          h('input', { className: 'som-input', placeholder: 'http://127.0.0.1:3000', value: form?.httpUrl ?? '', onChange: set('httpUrl') }),
          h('input', { className: 'som-input', placeholder: 'accessToken（留空表示不变）', type: 'password', value: form?.accessToken ?? '', onChange: set('accessToken') }),
          h('input', { className: 'som-input', placeholder: '允许的私聊 QQ（逗号分隔，* 表示全部）', value: form?.allowPrivate ?? '', onChange: set('allowPrivate') }),
          h('input', { className: 'som-input', placeholder: '允许的群号（逗号分隔，* 表示全部）', value: form?.allowGroups ?? '', onChange: set('allowGroups') }),
          h('input', { className: 'som-input', placeholder: '会话工作目录（可空）', value: form?.cwd ?? '', onChange: set('cwd') }),
          h(
            'label',
            { className: 'som-sub' },
            h('input', { type: 'checkbox', checked: Boolean(form?.groupRequireAt), onChange: (event) => setForm((prev) => ({ ...prev, groupRequireAt: event.target.checked })) }),
            ' 群里需要 @ 我才回（关掉则按群聊判断）'
          ),
          h(
            'label',
            { className: 'som-sub' },
            h('input', { type: 'checkbox', checked: form?.autoReply === false, onChange: (event) => setForm((prev) => ({ ...prev, autoReply: !event.target.checked })) }),
            ' 只听不回（聊天交给别的桥；自己只发主动消息）'
          ),
          h('div', { className: 'som-toolbar' }, h('button', { className: 'som-btn', onClick: save, disabled: busy }, '保存并接着连接'))
        ),
        h(
          'div',
          { className: 'som-card' },
          h(
            'div',
            { className: 'som-toolbar' },
            h('span', { className: 'som-badge' + (form?.groupPolicy !== 'off' ? ' som-ok' : '') }, form?.groupPolicy === 'smart' ? '群里看情况接话' : form?.groupPolicy === 'at' ? '只在 @ 我时回' : '群聊关闭'),
            h(
              'span',
              { className: 'som-sub' },
              status?.groupMood
                ? `此刻心情 愉悦 ${Number(status.groupMood.valence ?? 0).toFixed(2)} · 唤醒 ${Number(status.groupMood.arousal ?? 0).toFixed(2)}`
                : ''
            )
          ),
          h('div', { className: 'som-sub' }, '不是每条群消息都接：@我、回复我、提到「小忆」/「Seed」、或者聊到我感兴趣的东西才开口；心情低落时自动潜水。'),
          h(
            'div',
            { className: 'som-toolbar' },
            h('select', {
              className: 'som-input',
              value: form?.groupPolicy ?? 'smart',
              onChange: set('groupPolicy'),
            },
              h('option', { value: 'smart' }, '聪明模式（推荐）'),
              h('option', { value: 'at' }, '只在 @ 我时回'),
              h('option', { value: 'off' }, '群聊关闭')
            )
          ),
          h('input', {
            className: 'som-input',
            placeholder: '感兴趣的词（逗号分隔）',
            value: form?.groupTopics ?? '',
            onChange: set('groupTopics'),
          }),
          h(
            'div',
            { className: 'som-toolbar' },
            h('span', { className: 'som-sub' }, '间隔(秒)'),
            h('input', { className: 'som-input', style: { width: '64px' }, type: 'number', min: 0, value: form?.groupMinGapSec ?? 120, onChange: set('groupMinGapSec') }),
            h('span', { className: 'som-sub' }, '每小时'),
            h('input', { className: 'som-input', style: { width: '56px' }, type: 'number', min: 1, value: form?.groupMaxPerHour ?? 8, onChange: set('groupMaxPerHour') }),
            h('span', { className: 'som-sub' }, '每天'),
            h('input', { className: 'som-input', style: { width: '56px' }, type: 'number', min: 1, value: form?.groupMaxPerDay ?? 60, onChange: set('groupMaxPerDay') }),
            h('span', { className: 'som-sub' }, '夜里'),
            h('input', { className: 'som-input', style: { width: '48px' }, type: 'number', min: 0, max: 23, value: form?.groupQuietStart ?? 0, onChange: set('groupQuietStart') }),
            h('span', { className: 'som-sub' }, '–'),
            h('input', { className: 'som-input', style: { width: '48px' }, type: 'number', min: 0, max: 23, value: form?.groupQuietEnd ?? 7, onChange: set('groupQuietEnd') })
          ),
          status?.groupStats?.length
            ? h('div', { className: 'som-sub' }, status.groupStats.map((item) => `${item.key}：今天 ${item.dayCount ?? 0} 条`).join(' · '))
            : null,
          h('div', { className: 'som-toolbar' }, h('button', { className: 'som-btn', onClick: save, disabled: busy }, '保存群聊设置'))
        ),
        h(
          'div',
          { className: 'som-card' },
          h(
            'div',
            { className: 'som-toolbar' },
            h('span', { className: 'som-badge' + (state?.proactive?.config?.enabled ? ' som-ok' : '') }, state?.proactive?.config?.enabled ? '会主动找你' : '不主动'),
            h(
              'span',
              { className: 'som-sub' },
              state?.proactive?.state?.lastAt
                ? `上次 ${when(state.proactive.state.lastAt)}（${state.proactive.state.lastKind || '—'}）`
                : '还没主动说过话'
            )
          ),
          h('div', { className: 'som-sub' }, '不是定时唠叨：心情偏负会「担心」，依恋高又久没说话会「想你」，太久没动静会「有点空」，心情好会「想分享」。有安静时段、冷却和每日上限，默认一天最多 3 次。'),
          h(
            'label',
            { className: 'som-sub' },
            h('input', { type: 'checkbox', checked: Boolean(pro?.enabled), onChange: (event) => setPro((prev) => ({ ...prev, enabled: event.target.checked })) }),
            ' 开启主动找主人'
          ),
          h(
            'div',
            { className: 'som-toolbar' },
            h('span', { className: 'som-sub' }, '主人 QQ'),
            h('input', {
              className: 'som-input',
              style: { width: '140px' },
              type: 'text',
              inputMode: 'numeric',
              placeholder: '填你的 QQ 号',
              value: pro?.ownerQQ ?? '',
              onChange: (event) => setPro((prev) => ({ ...prev, ownerQQ: event.target.value })),
            }),
            h('span', { className: 'som-sub' }, `发给：${state?.proactive?.target || '还没填'}`)
          ),
          h(
            'div',
            { className: 'som-toolbar' },
            h('span', { className: 'som-sub' }, '冷却（小时）'),
            h('input', { className: 'som-input', style: { width: '64px' }, type: 'number', min: 0.5, step: 0.5, value: pro?.minIntervalHours ?? 4, onChange: (event) => setPro((prev) => ({ ...prev, minIntervalHours: event.target.value })) }),
            h('span', { className: 'som-sub' }, '每天最多'),
            h('input', { className: 'som-input', style: { width: '56px' }, type: 'number', min: 1, max: 20, value: pro?.maxPerDay ?? 3, onChange: (event) => setPro((prev) => ({ ...prev, maxPerDay: event.target.value })) }),
            h('span', { className: 'som-sub' }, '安静'),
            h('input', { className: 'som-input', style: { width: '52px' }, type: 'number', min: 0, max: 23, value: pro?.quietStart ?? 23, onChange: (event) => setPro((prev) => ({ ...prev, quietStart: event.target.value })) }),
            h('span', { className: 'som-sub' }, '–'),
            h('input', { className: 'som-input', style: { width: '52px' }, type: 'number', min: 0, max: 23, value: pro?.quietEnd ?? 8, onChange: (event) => setPro((prev) => ({ ...prev, quietEnd: event.target.value })) })
          ),
          h(
            'label',
            { className: 'som-sub' },
            h('input', { type: 'checkbox', checked: Boolean(pro?.voice), onChange: (event) => setPro((prev) => ({ ...prev, voice: event.target.checked })) }),
            ' 短句用语音说（沿用 QQ 语音设置）'
          ),
          h(
            'div',
            { className: 'som-toolbar' },
            h('button', { className: 'som-btn', onClick: savePro, disabled: busy }, '保存主动设置'),
            h('button', { className: 'som-btn', onClick: sayOnce, disabled: busy || !status?.connected }, '现在说一句')
          ),
          proNote ? h('div', { className: 'som-sub' }, proNote) : null,
          state?.proactive?.decision
            ? h(
                'div',
                { className: 'som-sub' },
                `现在：${state.proactive.decision.send ? '会开口' : '先不说'} · ${state.proactive.decision.reason}` +
                  (Number.isFinite(state.proactive.decision.hoursSinceUser) ? ` · 距上次说话 ${Math.round(state.proactive.decision.hoursSinceUser)} 小时` : '')
              )
            : null
        ),
        h(
          'div',
          { className: 'som-card' },
          h(
            'div',
            { className: 'som-toolbar' },
            h('span', { className: 'som-badge' + (state?.voice?.mode === 'full' ? ' som-ok' : '') }, voiceLabel(state?.voice?.mode)),
            h(
              'span',
              { className: 'som-sub' },
              state?.voice?.dshVoice?.installed
                ? `dsh-voice ${state.voice.dshVoice.version || ''}${state.voice.dshVoice.enabled ? '' : '（已停用）'}`
                : '没检测到 dsh-voice'
            ),
            h('button', { className: 'som-btn', onClick: refreshVoice, disabled: busy }, '重新检测')
          ),
          h('div', { className: 'som-sub' }, `听：${state?.voice?.asr?.ok ? '可以' : '不行 · ' + (state?.voice?.asr?.reason || '未探测')}`),
          h('div', { className: 'som-sub' }, `说：${state?.voice?.tts?.ok ? '可以' : '不行 · ' + (state?.voice?.tts?.reason || '未探测')}`),
          h('div', { className: 'som-sub' }, state?.voice?.hint ?? '没装语音也能用：听不到就提示一次，回复自动走文字。'),
          state?.voice?.tts?.url ? h('div', { className: 'som-sub' }, `ttsUrl：${state.voice.tts.url}`) : null
        ),
        h(
          'div',
          { className: 'som-card' },
          h('div', { className: 'som-sub' }, '最近事件'),
          (status?.log?.length ?? 0) === 0
            ? h('div', { className: 'som-empty' }, '还没有事件。连上后在 QQ 里发一句试试。')
            : h(
                'div',
                { className: 'som-log' },
                ...(status.log || []).slice(-14).map((row, index) =>
                  h('div', { key: index, className: 'som-logline' }, h('span', { className: 'som-tag' }, `${row.kind} · ${when(row.at)}`), ' ' + row.text)
                )
              )
        )
      )
    }

    const CONTACT_FIELDS = [
      ['name', '称呼'],
      ['relation', '关系'],
      ['birthday', '生日'],
      ['likes', '喜欢什么'],
      ['notes', '要留神的'],
    ]

    const blankForm = { name: '', relation: '', birthday: '', likes: '', notes: '' }

    function QingBar({ label, value, tone }) {
      const pct = Math.max(0, Math.min(100, Math.round(Number(value) || 0)))
      return h(
        'div',
        { className: 'som-qbar' },
        h('span', { className: 'som-qbar-k' }, label),
        h(
          'div',
          { className: 'som-qbar-track' },
          h('i', { className: `som-qbar-fill${tone ? ' ' + tone : ''}`, style: { width: `${pct}%` } })
        ),
        h('span', { className: 'som-qbar-v' }, String(pct))
      )
    }

    // 48 小时那条线。没有它，「情绪会变」只是一句话；有了它，才看得见。
    function QingCurve({ rows }) {
      if (!Array.isArray(rows) || rows.length < 2) {
        return h('div', { className: 'som-empty' }, '还没攒够小时点 —— 它在走，等一会儿再看。')
      }
      const w = 640
      const hgt = 120
      const pad = 6
      const series = [
        ['mood', 'rgba(90,170,255,.9)', '积极性'],
        ['tone', 'rgba(178,150,255,.85)', '这几天'],
        ['energy', 'rgba(120,210,160,.85)', '体力'],
      ]
      const all = []
      for (const [key] of series) {
        for (const row of rows) {
          const v = Number(row[key])
          if (Number.isFinite(v)) all.push(v)
        }
      }
      const lo = Math.min(...all, 20)
      const hi = Math.max(...all, 80)
      const span = Math.max(6, hi - lo)
      const x = (i) => pad + (i * (w - pad * 2)) / (rows.length - 1)
      const y = (v) => hgt - pad - ((Math.max(lo, Math.min(hi, v)) - lo) / span) * (hgt - pad * 2)
      return h(
        React.Fragment,
        null,
        h(
          'svg',
          { className: 'som-curve', viewBox: `0 0 ${w} ${hgt}`, preserveAspectRatio: 'none' },
          h('line', {
            x1: pad, y1: y(50), x2: w - pad, y2: y(50),
            stroke: 'rgba(127,127,127,.22)', strokeWidth: '1', strokeDasharray: '3 3',
          }),
          series.map(([key, color]) =>
            h('polyline', {
              key,
              // 缺值的那一个点直接不画 —— 以前写成 `|| 0`，会把它按 0 算、贴着底画一笔，
              // 看着像「那天心情掉到谷底」，其实只是那一行没这个字段。
              points: rows
                .map((row, i) => {
                  const v = Number(row[key])
                  return Number.isFinite(v) ? `${x(i)},${y(v)}` : null
                })
                .filter(Boolean)
                .join(' '),
              fill: 'none',
              stroke: color,
              strokeWidth: '1.6',
              strokeLinejoin: 'round',
              strokeLinecap: 'round',
            })
          )
        ),
        h(
          'div',
          { className: 'som-legend' },
          series.map(([key, color, label]) => h('span', { key }, h('i', { style: { background: color } }), label))
        )
      )
    }

    function QingView() {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          setData(await getJson('/qing?hours=48'))
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      if (!data) return h('div', { className: 'som-empty' }, error || '读取中…')

      const history = Array.isArray(data.history) ? data.history : []
      const recent = Array.isArray(data.recent) ? data.recent.slice().reverse() : []
      const shown = Number(data.shown)
      const delta = Math.round(shown - (Number(data.baseline) || 50))

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'som-card' },
          h(
            'div',
            { className: 'som-mood' },
            h(
              'div',
              null,
              h('div', { className: 'som-sub' }, `${data.phase ?? '此刻'} · 现在`),
              h('div', { className: 'som-mood-label' }, Number.isFinite(shown) ? String(shown) : '—')
            ),
            h(
              'div',
              { className: 'som-metrics' },
              h('span', null, `此刻 ${data.moodRaw ?? data.mood}`),
              data.today ? h('span', null, `今天 ${data.today.lo}–${data.today.hi}`) : null,
              h('span', null, `底子 ${data.baseline ?? '—'}`),
              h('span', null, `节律 ${data.offset > 0 ? '+' : ''}${data.offset ?? 0}`),
              h('span', null, `比底子 ${delta > 0 ? '+' : ''}${delta}`),
              h(
                'button',
                { className: 'som-btn', onClick: load, disabled: busy },
                busy ? '…' : '刷新'
              )
            )
          ),
          h('div', { className: 'som-qline' }, data.line ?? ''),
          h(QingCurve, { rows: history }),
          error ? h('div', { className: 'som-error' }, error) : null
        ),
        h(
          'div',
          { className: 'som-card' },
          h('div', { className: 'som-sub' }, '底色 · 走得慢的那几条'),
          h(QingBar, { label: '积极性', value: data.shown ?? data.mood }),
          h(QingBar, { label: '这几天', value: data.tone }),
          h(QingBar, { label: '体力', value: data.energy, tone: 'cool' }),
          h(
            'div',
            { className: 'som-sub', style: { marginTop: 4 } },
            '积极性是此刻（横条叠了昼夜，同一个数凌晨看低、上午看高）；这几天要小半天才回得来；底子被日子推着走，一天挪几点；日子本身就是会自己挪的。'
          ),
          data.enabled === false ? h('div', { className: 'som-sub som-warn' }, '情绪内核关着：这些数不会动，也不上卡片。') : null
        ),
        h(
          'div',
          { className: 'som-card' },
          h('div', { className: 'som-sub' }, '此刻的心情 · 亮着的，和堵着的'),
          h(QingBar, { label: '开心', value: data.joy, tone: 'good' }),
          h(QingBar, { label: '亲近', value: data.warm, tone: 'good' }),
          h(QingBar, { label: '有盼头', value: data.hope, tone: 'good' }),
          h('div', { className: 'som-bar-gap' }),
          h(QingBar, { label: '委屈', value: data.hurt, tone: 'warm' }),
          h(QingBar, { label: '愧疚', value: data.guilt, tone: 'warm' }),
          h(QingBar, { label: '压力', value: data.pressure, tone: 'warm' }),
          h(
            'div',
            { className: 'som-sub', style: { marginTop: 4 } },
            '上面三条平时就在那儿 —— 本来对你就挺高兴、挺亲近；被夸会涨，被靠过来会涨，说到以后也会涨。下面三条是堵着的，说开了会自己掉。'
          )
        ),
        h(
          'div',
          { className: 'som-card' },
          h('div', { className: 'som-sub' }, '最近那几下'),
          recent.length
            ? recent.map((entry, i) =>
                h(
                  'div',
                  { className: 'som-row', key: `${entry.at}-${i}` },
                  h(
                    'div',
                    { className: 'som-claim' },
                    entry.note || entry.kind || '—',
                    h(
                      'div',
                      { className: 'som-sub' },
                      `${when(entry.at)}${entry.quote ? ` · 「${entry.quote}」` : ''}${entry.energy ? ` · 体力 ${entry.energy}` : ''}`
                    )
                  ),
                  h('span', { className: 'som-badge' }, `${entry.delta > 0 ? '+' : ''}${entry.delta ?? 0}`)
                )
              )
            : h('div', { className: 'som-empty' }, '还没有。')
        )
      )
    }

    function FriendView() {
      const [contacts, setContacts] = React.useState(null)
      const [loose, setLoose] = React.useState([])
      const [scope, setScope] = React.useState('private')
      const [id, setId] = React.useState('')
      const [form, setForm] = React.useState(blankForm)
      const [looseForm, setLooseForm] = React.useState({ peer: '', ask: '' })
      const [editing, setEditing] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const committing = React.useRef(false)

      const load = async () => {
        try {
          const [a, b] = await Promise.all([getJson('/contacts'), getJson('/loose')])
          setContacts(a.rows ?? [])
          setLoose(b.rows ?? [])
          setError('')
        } catch (err) {
          setError(String(err?.message ?? err))
        }
      }

      React.useEffect(() => {
        void load()
      }, [])

      const post = async (path, body) => {
        setBusy(true)
        try {
          await getJson(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
          await load()
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }

      const saveNew = () => {
        const who = id.trim()
        if (!who) {
          setError('先填对方的号')
          return
        }
        void post('/contacts', { peer: `${scope}:${who}`, ...form })
        setId('')
        setForm(blankForm)
      }

      // 新挂一句。以前这里没有入口，只能靠工具 seed_loose add —— 顺手补上。
      const saveLoose = () => {
        const ask = looseForm.ask.trim()
        if (!ask) {
          setError('先写要问的那句')
          return
        }
        void post('/loose', { peer: looseForm.peer.trim(), ask })
        setLooseForm({ peer: '', ask: '' })
      }

      // 输入框里按回车就提交（省得每次去够那只按钮）
      const onEnter = (fn) => (event) => {
        if (event.key !== 'Enter' || event.nativeEvent?.isComposing) return
        event.preventDefault()
        fn()
      }

      const beginEdit = (row, field) => {
        if (busy) return
        committing.current = false
        setEditing({ peer: row.peer, field })
        setDraft(String(row[field] ?? ''))
      }

      const commitEdit = () => {
        if (!editing || committing.current) return
        committing.current = true
        const { peer, field } = editing
        const value = draft
        setEditing(null)
        void post('/contacts', { peer, [field]: value })
      }

      const cancelEdit = () => {
        committing.current = true
        setEditing(null)
      }

      const ago = (ts) => {
        const diff = Date.now() - Number(ts || 0)
        if (!Number.isFinite(diff) || diff < 0) return ''
        if (diff < 60_000) return '刚刚'
        if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`
        if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`
        return `${Math.round(diff / 86_400_000)} 天前`
      }

      const due = (row) => {
        const at = Number(row.due_at || 0)
        if (!at) return null
        const left = at - Date.now()
        if (left <= 0) return { text: '已过期', late: true }
        const hours = Math.round(left / 3_600_000)
        if (hours >= 48) return { text: `还有 ${Math.round(hours / 24)} 天`, late: false }
        return { text: `还有 ${Math.max(1, hours)} 小时`, late: false }
      }

      const statusLabel = { open: '等着回话', answered: '他回了，还没收', done: '完成', cancelled: '取消', updated: '更新' }
      // 从界面上挂的话可能没指定问谁，存成 gui；显示时说人话。
      const peerText = (peer) => (peer === 'gui' ? '当面 / 没说' : peer)

      const fieldRow = (row, field, label) => {
        const on = editing && editing.peer === row.peer && editing.field === field
        const value = String(row[field] ?? '')
        return h(
          'div',
          { className: 'som-field', key: field },
          h('span', { className: 'som-field-k' }, label),
          on
            ? h('input', {
                className: 'som-input',
                autoFocus: true,
                value: draft,
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitEdit()
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelEdit()
                  }
                },
                onBlur: () => commitEdit(),
              })
            : h(
                'span',
                { className: 'som-field-v' + (value ? '' : ' som-blank'), title: '点一下改', onClick: () => beginEdit(row, field) },
                value || '未填 · 点一下补'
              )
        )
      }

      const kindLabel = (peer) => (String(peer).startsWith('group:') ? 'QQ 群' : 'QQ 私聊')
      const peerId = (peer) => String(peer).split(':').slice(1).join(':')

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'som-card' },
          h('div', null, h('div', { className: 'som-title' }, '熟人卡'), h('div', { className: 'som-sub' }, '一个人一张，一个群一张。聊天时我按人取这一张——点任意一行就能改。')),
          error ? h('div', { className: 'som-error' }, error) : null,
          contacts === null
            ? h('div', { className: 'som-empty' }, '读取中…')
            : contacts.length === 0
              ? h('div', { className: 'som-empty' }, '还没有卡。下面写第一张吧。')
              : h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                  ...contacts.map((row) =>
                    h(
                      'div',
                      { key: row.peer, className: 'som-friend' },
                      h(
                        'div',
                        { className: 'som-friend-head' },
                        h(
                          'div',
                          null,
                          h('span', { className: 'som-friend-name' }, row.name || '（还没写称呼）'),
                          h('span', { className: 'som-friend-who' }, `${kindLabel(row.peer)} · ${peerId(row.peer)}`)
                        ),
                        h('button', { className: 'som-btn som-danger', onClick: () => void post('/contacts', { peer: row.peer, forget: true }) }, '删掉')
                      ),
                      ...CONTACT_FIELDS.map(([field, label]) => fieldRow(row, field, label))
                    )
                  )
                ),
          h(
            'div',
            { className: 'som-newblock' },
            h('div', { className: 'som-sub' }, '写一张新的'),
            h(
              'div',
              { className: 'som-toolbar' },
              h(
                'select',
                { className: 'som-select', value: scope, onChange: (event) => setScope(event.target.value) },
                h('option', { value: 'private' }, 'QQ 私聊'),
                h('option', { value: 'group' }, 'QQ 群')
              ),
              h('input', {
                className: 'som-input',
                value: id,
                onChange: (event) => setId(event.target.value),
                onKeyDown: onEnter(saveNew),
                placeholder: scope === 'group' ? '群号' : '对方的 QQ 号',
              })
            ),
            h('div', { className: 'som-peerhint' }, `存成 ${scope}:${id.trim() || '…'}`),
            ...CONTACT_FIELDS.map(([field, label]) =>
              h(
                'div',
                { className: 'som-field', key: field },
                h('span', { className: 'som-field-k' }, label),
                h('input', {
                  className: 'som-input',
                  value: form[field],
                  onChange: (event) => setForm({ ...form, [field]: event.target.value }),
                  placeholder: field === 'birthday' ? '3-14，或者 1998-03-14' : '',
                })
              )
            ),
            h(
              'div',
              { className: 'som-toolbar', style: { justifyContent: 'flex-end' } },
              h('button', { className: 'som-btn', onClick: saveNew, disabled: busy || !id.trim() }, '写进卡里')
            )
          )
        ),
        h(
          'div',
          { className: 'som-card' },
          h('div', null, h('div', { className: 'som-title' }, '未完话头'), h('div', { className: 'som-sub' }, '我问过、还没落定的那一句。他回了会自动标成「他回了」，我再判断完成、取消还是更新。')),
          loose.length === 0
            ? h('div', { className: 'som-empty' }, '没有挂着的话头。')
            : h(
                'div',
                null,
                ...loose.map((row) => {
                  const closed = row.status === 'done' || row.status === 'cancelled' || row.status === 'updated'
                  const left = due(row)
                  return h(
                    'div',
                    { key: row.id, className: 'som-row' },
                    h(
                      'div',
                      { className: 'som-claim' },
                      h('div', null, row.ask),
                      h(
                        'div',
                        { className: 'som-sub' },
                        `${peerText(row.peer)} · ${statusLabel[row.status] || row.status} · 挂了 ${ago(row.asked_at)}`,
                        left ? h('span', { className: left.late ? 'som-late' : 'som-warn' }, ` · ${left.text}`) : null
                      )
                    ),
                    closed
                      ? null
                      : h(
                          'div',
                          { style: { display: 'flex', gap: 6 } },
                          h('button', { className: 'som-btn', onClick: () => void post('/loose', { id: row.id, status: 'done' }) }, '完成'),
                          h('button', { className: 'som-btn', onClick: () => void post('/loose', { id: row.id, status: 'cancelled' }) }, '取消'),
                          h('button', { className: 'som-btn', onClick: () => void post('/loose', { id: row.id, status: 'updated' }) }, '更新')
                        )
                  )
                })
              ),
          h(
            'div',
            { className: 'som-newblock', style: { marginTop: 10 } },
            h('div', { className: 'som-sub' }, '再挂一句'),
            h(
              'div',
              { className: 'som-toolbar' },
              h('input', {
                className: 'som-input',
                value: looseForm.peer,
                onChange: (event) => setLooseForm({ ...looseForm, peer: event.target.value }),
                placeholder: '问谁（可留空）',
                style: { maxWidth: 180 },
              }),
              h('input', {
                className: 'som-input',
                value: looseForm.ask,
                onChange: (event) => setLooseForm({ ...looseForm, ask: event.target.value }),
                onKeyDown: onEnter(saveLoose),
                placeholder: '要问的那一句',
              }),
              h('button', { className: 'som-btn', onClick: saveLoose, disabled: busy || !looseForm.ask.trim() }, '挂上')
            ),
            h('div', { className: 'som-peerhint' }, '他回了会自动标成「他回了」；两天没回音会拎出来问一句。')
          )
        )
      )
    }

    function BiliView() {
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [note, setNote] = React.useState('')
      const askedRef = React.useRef(false)

      const load = React.useCallback(async () => {
        try {
          setStatus(await getJson('/bili/status'))
        } catch (err) {
          setNote(String(err?.message ?? err))
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      async function install() {
        setBusy('install')
        setNote('')
        try {
          const result = await getJson('/bili/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          setNote(result.ok ? '安装完成，正在启用。' : '安装失败：' + (result.error || '未知原因'))
          await load()
        } catch (err) {
          setNote('安装失败：' + String(err?.message ?? err))
        } finally {
          setBusy('')
        }
      }

      async function dismiss() {
        try {
          await getJson('/bili/dismiss', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          setNote('好，不装了。想装的时候点下面的「安装」。')
          await load()
        } catch {}
      }

      React.useEffect(() => {
        if (askedRef.current || !status?.ok) return
        askedRef.current = true
        if (status.installed || status.pref?.dismissedAt) return
        const yes = window.confirm(
          '没有检测到「刷B站」插件（dsh-bili-scroll）。\n\n装它，我才能读到你今天刷了什么、哪些值得看；不装的话这个模块就空着。\n\n现在安装吗？'
        )
        if (yes) install()
        else dismiss()
      }, [status])

      async function enable() {
        setBusy('enable')
        try {
          const result = await getJson('/bili/enable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          setNote(result.ok ? '已启用。' : '启用失败：' + (result.error || '未知原因'))
          await load()
        } finally {
          setBusy('')
        }
      }

      async function sync() {
        setBusy('sync')
        try {
          const result = await getJson('/bili/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"days":3}' })
          setNote(`同步完成：新增待记 ${result.added ?? 0} 条。`)
          await load()
        } catch (err) {
          setNote('同步失败：' + String(err?.message ?? err))
        } finally {
          setBusy('')
        }
      }

      if (!status) return h('div', { className: 'som-sub' }, '正在检测「刷B站」插件…')

      const reports = status.reports ?? {}
      const syncState = status.sync ?? {}

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'som-card' },
          h('div', { className: 'som-sub' }, '「刷B站」插件'),
          status.installed
            ? h(
                'div',
                null,
                h(
                  'div',
                  { className: 'som-row' },
                  h('span', { className: 'som-badge ' + (status.enabled ? 'som-ok' : 'contested') }, status.enabled ? '已安装 · 启用中' : '已安装 · 未启用'),
                  h('span', { className: 'som-sub' }, status.version ? `v${status.version}` : ''),
                  status.enabled
                    ? null
                    : h('button', { className: 'som-btn', onClick: enable, disabled: busy === 'enable' }, busy === 'enable' ? '启用中…' : '启用')
                )
              )
            : h(
                'div',
                null,
                h('div', { className: 'som-row' }, h('span', { className: 'som-badge contested' }, '未安装')),
                h('div', { className: 'som-sub' }, '装它之后，我才能读到你今天刷了什么、哪些值得看；不装就只用一个空模块。'),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, marginTop: 8 } },
                  h('button', { className: 'som-btn', onClick: install, disabled: busy === 'install' }, busy === 'install' ? '安装中…' : '安装'),
                  h('button', { className: 'som-btn', onClick: dismiss }, '不装')
                )
              ),
          h('div', { className: 'som-sub', style: { marginTop: 8 } }, `日报目录：${status.dir || ''}`)
        ),
        h(
          'div',
          { className: 'som-card' },
          h('div', { className: 'som-sub' }, '最近 7 天日报'),
          h(
            'div',
            { className: 'som-row' },
            h('span', null, `${reports.files ?? 0} 份 · 值得看 ${reports.worth ?? 0} · 可以看 ${reports.okay ?? 0}`),
            h('span', { className: 'som-sub' }, reports.lastDay ? `最新 ${reports.lastDay}` : '还没有日报')
          ),
          h(
            'div',
            { className: 'som-row' },
            h('span', { className: 'som-sub' }, `已同步 ${syncState.seen ?? 0} 个视频${syncState.at ? ' · ' + when(syncState.at) : ''}`),
            h('button', { className: 'som-btn', onClick: sync, disabled: busy === 'sync' }, busy === 'sync' ? '同步中…' : '立即同步')
          ),
          h(
            'div',
            { className: 'som-sub', style: { marginTop: 6 } },
            '同步只把「值得看 / 可以看」放进「记忆」页的待记；点「记下」才会写进记忆，不点就只停在待记里。'
          )
        ),
        note ? h('div', { className: 'som-error' }, note) : null
      )
    }

    function guideInline(text, keyBase) {
      const parts = []
      const re = /`([^`]+)`/g
      let index = 0
      let match
      while ((match = re.exec(text))) {
        if (match.index > index) parts.push(text.slice(index, match.index))
        parts.push(h('code', { key: keyBase + '-c' + parts.length, className: 'som-guide-code' }, match[1]))
        index = match.index + match[0].length
      }
      if (index < text.length) parts.push(text.slice(index))
      return parts.length ? parts : text
    }

    function guideBlocks(markdown) {
      const out = []
      let list = null
      let code = null
      const flushList = () => {
        if (list) {
          out.push(h('ul', { key: 'l' + out.length, className: 'som-guide-list' }, ...list))
          list = null
        }
      }
      const flushCode = () => {
        if (code) {
          out.push(h('pre', { key: 'c' + out.length, className: 'som-guide-pre' }, code.join('\n')))
          code = null
        }
      }
      for (const raw of String(markdown ?? '').split('\n')) {
        const line = raw.replace(/\s+$/, '')
        if (code) {
          if (line.startsWith('```')) flushCode()
          else code.push(raw)
          continue
        }
        if (line.startsWith('```')) {
          flushList()
          code = []
          continue
        }
        const heading = /^(#{1,3})\s+(.*)$/.exec(line)
        if (heading) {
          flushList()
          const tag = heading[1].length === 1 ? 'h1' : heading[1].length === 2 ? 'h2' : 'h3'
          out.push(h(tag, { key: 'h' + out.length, className: 'som-guide-' + tag }, heading[2]))
          continue
        }
        if (line.startsWith('- ')) {
          if (!list) list = []
          list.push(h('li', { key: 'li' + out.length + '-' + list.length }, ...guideInline(line.slice(2), 'li' + list.length)))
          continue
        }
        if (!line) {
          flushList()
          continue
        }
        flushList()
        out.push(h('p', { key: 'p' + out.length, className: 'som-guide-p' }, ...guideInline(line, 'p' + out.length)))
      }
      flushList()
      flushCode()
      return out
    }

    function GuideView() {
      const [doc, setDoc] = useState(null)
      const [error, setError] = useState('')
      useEffect(() => {
        getJson('/guide')
          .then(setDoc)
          .catch((err) => setError(String(err?.message ?? err)))
      }, [])
      return h(
        'div',
        { className: 'som-card' },
        h('div', { className: 'som-sub' }, `说明书${doc?.version ? '（v' + doc.version + '）' : ''}`),
        error ? h('div', { className: 'som-error' }, error) : null,
        h('div', { className: 'som-guide' }, ...guideBlocks(doc?.markdown))
      )
    }

    function Panel() {
      const [state, setState] = useState(null)
      const [tab, setTab] = useState('overview')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          setState(await getJson('/state'))
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const setStatus = useCallback(
        async (belief, status) => {
          try {
            await getJson('/belief', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: belief.id, status }),
            })
            await load()
          } catch (err) {
            setError(String(err?.message ?? err))
          }
        },
        [load]
      )

      const mood = state?.mood
      const stats = state?.stats
      const tiers = state?.consolidation?.tiers ?? []
      const storage = state?.storage
      const links = state?.links ?? {}
      const openLink = (url) => {
        if (url) window.open(url, '_blank', 'noopener')
      }
      const fmtFree = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`)
      const storageBanner = storage?.low
        ? h(
            'div',
            { className: 'som-card', style: { borderColor: '#c2410c' } },
            h('div', { className: 'som-sub', style: { color: '#c2410c', fontWeight: 600 } }, '磁盘空间不足'),
            h(
              'div',
              { className: 'som-sub' },
              `记忆目录 ${storage.path} 只剩 ${fmtFree(storage.freeMB)}（阈值 ${storage.minFreeMB} MB）。请清理磁盘，或把该目录搬到更大的盘；空间恢复前新记忆可能写不进去。`
            )
          )
        : null
      const layers = (stats?.byLayer || [])
        .filter((row) => row.status === 'active' && row.n > 0)
        .map((row) => `${layerLabel(row.layer)} ${row.n}`)
        .join(' · ')

      const consolidateNow = useCallback(async () => {
        try {
          setBusy(true)
          await getJson('/consolidate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          await load()
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [load])

      const tabs = [
        ['overview', '概览'],
        ['memory', '记忆'],
        ['beliefs', '认知'],
        ['persona', '人格'],
        ['feelings', '情绪'],
        ['qing', '心情'],
        ['embedding', '检索'],
        ['bili', 'B站'],
        ['qq', 'QQ'],
        ['friend', '熟人'],
        ['root', '根'],
        ['guide', '说明'],
      ]

      const overview = h(
        React.Fragment,
        null,
        storageBanner,
        h(
          'div',
          { className: 'som-card' },
          h(
            'div',
            { className: 'som-mood' },
            h('div', null, h('div', { className: 'som-sub' }, '此刻'), h('div', { className: 'som-mood-label' }, mood?.label ?? '—')),
            h(
              'div',
              { className: 'som-metrics' },
              h('span', null, `愉悦 ${mood ? mood.valence.toFixed(2) : '—'}`),
              h('span', null, `唤醒 ${mood ? mood.arousal.toFixed(2) : '—'}`),
              ...(mood?.cause ? [h('span', { className: 'som-cause' }, `因为 ${mood.cause}`)] : [])
            )
          ),
          h(Spark, { emotions: state?.emotions ?? [] })
        ),

        h(
          'div',
          { className: 'som-card' },
          h('div', { className: 'som-sub' }, `记忆 ${stats?.total ?? 0} 条${layers ? '（' + layers + '）' : ''} · 卡片 ${state?.cardBytes ?? 0} 字节`),
          h(
            'div',
            { className: 'som-sub', style: { marginTop: 2 } },
            tiers.length
              ? '分层：' + tiers.map((row) => `${tierLabel(row.tier)} ${row.n}`).join(' · ')
              : '分层：（还没有数据）',
            h(
              'button',
              { className: 'som-btn', style: { marginLeft: 10 }, onClick: consolidateNow, disabled: busy },
              '整理一次（升级 / 退场）'
            )
          ),
          h('div', { className: 'som-sub', style: { marginTop: -6 } }, '认知与情绪各有独立页；情绪只影响记忆权重、召回偏置和语气，不改写事实与身份根。'),
          storage
            ? h(
                'div',
                { className: 'som-sub', style: { marginTop: 2, color: storage.low ? '#c2410c' : undefined } },
                `存储：剩余 ${fmtFree(storage.freeMB)}（阈值 ${storage.minFreeMB} MB） · ${storage.path}`
              )
            : null
        ),

        h(
          'div',
          { className: 'som-card' },
          h('div', { className: 'som-sub' }, '离线资源'),
          h(
            'div',
            { className: 'som-sub', style: { marginTop: 2 } },
            '检索运行时和语音模型比较大，不放进代码仓库；两个地方都能下，按需挑一个。'
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 } },
            links.release
              ? h('button', { className: 'som-btn', onClick: () => openLink(links.release) }, 'GitHub Releases')
              : null,
            links.xunlei
              ? h(
                  'button',
                  { className: 'som-btn', onClick: () => openLink(links.xunlei) },
                  `迅雷网盘${links.xunleiCode ? `（提取码 ${links.xunleiCode}）` : ''}`
                )
              : null
          )
        )
      )

      return h(
        'div',
        { className: 'som-panel' },
        h(
          'div',
          { className: 'som-head' },
          h('div', null, h('div', { className: 'som-title' }, '记忆之种'), h('div', { className: 'som-sub' }, 'Seed of Memory · 根、记忆、认知与心情')),
          h('button', { className: 'som-btn', onClick: load, disabled: busy }, busy ? '刷新中…' : '刷新')
        ),
        h(
          'div',
          { className: 'som-tabs' },
          ...tabs.map(([id, label]) =>
            h('button', { key: id, className: 'som-tab' + (tab === id ? ' som-on' : ''), onClick: () => setTab(id) }, label)
          )
        ),
        error ? h('div', { className: 'som-error' }, error) : null,
        tab === 'overview'
          ? overview
          : tab === 'memory'
            ? h(MemoryView)
            : tab === 'beliefs'
              ? h(BeliefsView, { state, reload: load })
              : tab === 'persona'
                ? h(PersonaView)
                : tab === 'feelings'
                  ? h(EmotionsView)
                  : tab === 'qing'
                    ? h(QingView)
                  : tab === 'embedding'
                    ? h(EmbeddingView)
                      : tab === 'bili'
                        ? h(BiliView)
                      : tab === 'qq'
                        ? h(QqView)
                        : tab === 'friend'
                          ? h(FriendView)
                          : tab === 'guide'
                          ? h(GuideView)
                          : h(RootView),
        h(
          'div',
          { className: 'som-foot' },
          h('span', null, '根：anchors.md + self.md + us.md（每轮注入，不衰减）'),
          h('span', null, `Seed of Memory v${state?.version ?? '1.1.0'}`)
        )
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-seed-of-memory'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'seed-of-memory: styles')

      try {
        const slots = ctx.get('slots')
        if (!slots) return
        ctx.effect(
          () =>
            slots.inject('settings.section', () =>
              slots.register(
                { name: 'settings.section', id: 'seed-of-memory', order: 36, label: '记忆之种' },
                () => h(Panel)
              )
            ),
          'seed-of-memory: settings section'
        )
      } catch (error) {
        console.error('[seed-of-memory] 设置页注册失败：' + (error?.message ?? error))
      }
    }

    return { name: 'dsh-seed-of-memory', inject, apply }
  },
})
