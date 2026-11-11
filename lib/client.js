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
.som-tabs{display:flex;gap:6px}
.som-tab{font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;cursor:pointer;opacity:.7}
.som-tab.som-on{opacity:1;border-color:rgba(90,170,255,.65);background:rgba(90,170,255,.12)}
.som-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.som-input,.som-textarea{font:inherit;color:inherit;background:transparent;border:1px solid rgba(127,127,127,.35);border-radius:7px;padding:4px 8px}
.som-input{min-width:180px;flex:1}
.som-textarea{width:100%;min-height:190px;resize:vertical;line-height:1.55;font-family:inherit}
.som-tag{font-size:11px;opacity:.6;white-space:nowrap}
.som-danger{color:#e0655b}
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

    function LayerTag({ layer }) {
      return h('span', { className: 'som-tag' }, layer)
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
            placeholder: '记下一条新的判断（她说了什么、我看到的规律）',
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
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

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
        ['persona', 'persona'],
        ['semantic', 'semantic'],
        ['episodic', 'episodic'],
        ['buffer', 'buffer'],
      ]

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
        error ? h('div', { className: 'som-error' }, error) : null,
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
                    row.emotion ? h('span', { className: 'som-badge' }, row.emotion) : null,
                    h('span', { className: 'som-badge' }, `重要 ${Number(row.importance).toFixed(2)}`),
                    h('span', { className: 'som-badge' }, row.source),
                    h('span', { className: 'som-tag' }, when(row.recordedAt))
                  )
                ),
                h('button', { className: 'som-btn som-danger', onClick: () => forget(row) }, '删除')
              )
            )
          : h('div', { className: 'som-empty' }, q ? '没有匹配的记忆。' : '这一层还没有条目。')
      )
    }

    function RootView() {
      const [raw, setRaw] = useState(null)
      const [drafts, setDrafts] = useState({ identity: '', us: '' })
      const [error, setError] = useState('')
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          const data = await getJson('/root')
          setRaw(data)
          setDrafts({ identity: data.identity ?? '', us: data.us ?? '' })
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
            setRaw(data)
            setDrafts({ identity: data.identity, us: data.us })
            setNote(which === 'identity' ? '「我是谁」已保存' : '「我们」已保存')
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
        h('div', { className: 'som-sub' }, '身份根：每轮注入在最前面，不衰减、不被删除。改完下一轮就生效；换会话/换模型也读同一份。'),
        error ? h('div', { className: 'som-error' }, error) : null,
        note ? h('div', { className: 'som-sub' }, note) : null,
        h('div', { className: 'som-sub' }, `我是谁 · ${byteCount(drafts.identity)} 字节`),
        h('textarea', {
          className: 'som-textarea',
          value: drafts.identity,
          onChange: (e) => setDrafts({ ...drafts, identity: e.target.value }),
        }),
        h(
          'div',
          { className: 'som-toolbar' },
          h('button', { className: 'som-btn', onClick: () => save('identity'), disabled: busy }, '保存「我是谁」'),
          h('button', { className: 'som-btn', onClick: load, disabled: busy }, busy ? '读取中…' : '重新读取')
        ),
        h('div', { className: 'som-sub', style: { marginTop: 6 } }, `我们之间 · ${byteCount(drafts.us)} 字节`),
        h('textarea', {
          className: 'som-textarea',
          value: drafts.us,
          onChange: (e) => setDrafts({ ...drafts, us: e.target.value }),
        }),
        h('div', { className: 'som-toolbar' }, h('button', { className: 'som-btn', onClick: () => save('us'), disabled: busy }, '保存「我们之间」')),
        h('div', { className: 'som-sub' }, '上限 8000 字节；只写稳定的事（称呼、约定、重要日期），不要写会变的细节。')
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
            : h('div', { className: 'som-empty' }, '还没有说话习惯。她纠正你的表达方式时，会自动记一条。'),
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
      const layers = (stats?.byLayer || [])
        .filter((row) => row.status === 'active' && row.n > 0)
        .map((row) => `${row.layer} ${row.n}`)
        .join(' · ')

      const tabs = [
        ['overview', '概览'],
        ['memory', '记忆'],
        ['beliefs', '认知'],
        ['persona', '人格'],
        ['feelings', '情绪'],
        ['root', '根'],
      ]

      const overview = h(
        React.Fragment,
        null,
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
          h('div', { className: 'som-sub', style: { marginTop: -6 } }, '认知与情绪各有独立页；情绪只影响记忆权重、召回偏置和语气，不改写事实与身份根。')
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
                  : h(RootView),
        h(
          'div',
          { className: 'som-foot' },
          h('span', null, '根：identity.md + us.md（每轮注入，不衰减）'),
          h('span', null, 'Seed of Memory v0.4.0')
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
