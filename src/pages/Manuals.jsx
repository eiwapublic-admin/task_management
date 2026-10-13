import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import ManualForm from '../components/ManualForm'
import { IconSearch } from '../components/Icons'
import { MANUAL_KINDS, MANUAL_KIND_LABELS, MANUAL_FIELD_DEFS, fetchManuals, manualSearchText } from '../lib/manuals'
import './Dashboard.css'
import './Contacts.css'
import './Manuals.css'

// 業務マニュアル（日常業務の手引書。2026-10-13〜）。依頼元の「対応マニュアル.xlsx」を取り込んだもの。
// 種類（対応マニュアル・定例作業・関連手順）で切り替えて一覧し、キーワードで全種類から絞り込める。
// 項目をタップすると中身が開く。検索中は該当した項目を最初から開き、該当箇所に色を付ける。
// 本文中の URL はリンク、電話番号は発信リンクにする。定例作業から関連手順へは「関連」から移れる。

const URL_RE = /(https?:\/\/[^\s　）)」]+)/
const PHONE_RE = /(0\d{1,4}-\d{1,4}-\d{3,4})/

// 文字列を、検索語の強調・URL・電話番号のリンクを含む React 要素の列にする
function RichText({ text, query }) {
  const parts = useMemo(() => {
    const out = []
    // まず URL・電話番号で区切る（どちらにも当たらない部分は検索語の強調だけを付ける）
    const tokens = text.split(new RegExp(`${URL_RE.source}|${PHONE_RE.source}`, 'g')).filter((t) => t !== undefined && t !== '')
    tokens.forEach((t, i) => {
      if (URL_RE.test(t) && t.match(URL_RE)[0] === t) {
        out.push(
          <a key={i} href={t} target="_blank" rel="noreferrer">
            <Highlight text={t} query={query} />
          </a>
        )
      } else if (PHONE_RE.test(t) && t.match(PHONE_RE)[0] === t) {
        out.push(
          <a key={i} href={`tel:${t}`}>
            <Highlight text={t} query={query} />
          </a>
        )
      } else {
        out.push(<Highlight key={i} text={t} query={query} />)
      }
    })
    return out
  }, [text, query])
  return <>{parts}</>
}

function Highlight({ text, query }) {
  const q = query.trim()
  if (!q) return text
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  const out = []
  let pos = 0
  for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, pos)) {
    if (i > pos) out.push(text.slice(pos, i))
    out.push(<mark key={i}>{text.slice(i, i + needle.length)}</mark>)
    pos = i + needle.length
  }
  if (pos < text.length) out.push(text.slice(pos))
  return <>{out}</>
}

export default function Manuals() {
  const [manuals, setManuals] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState('all')
  const [openIds, setOpenIds] = useState(() => new Set())
  const [editing, setEditing] = useState(null) // null | { kind } (新規) | manual
  const itemRefs = useRef(new Map())

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setManuals(await fetchManuals())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const byId = useMemo(() => new Map(manuals.map((m) => [m.id, m])), [manuals])
  const q = query.trim().toLowerCase()
  const matched = useMemo(() => (q ? manuals.filter((m) => manualSearchText(m).includes(q)) : manuals), [manuals, q])
  const counts = useMemo(() => {
    const c = { all: matched.length }
    for (const k of MANUAL_KINDS) c[k.key] = matched.filter((m) => m.kind === k.key).length
    return c
  }, [matched])
  const groups = MANUAL_KINDS.filter((k) => tab === 'all' || tab === k.key)
    .map((k) => ({ ...k, rows: matched.filter((m) => m.kind === k.key) }))
    .filter((g) => g.rows.length > 0)

  function toggle(id) {
    setOpenIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // 「関連」から別の項目へ移る。検索や種類の絞り込みで隠れていても見えるようにしてから開いて、そこまでスクロールする
  function jumpTo(id) {
    const target = byId.get(id)
    if (!target) return
    if (q && !manualSearchText(target).includes(q)) setQuery('')
    if (tab !== 'all' && tab !== target.kind) setTab('all')
    setOpenIds((prev) => new Set(prev).add(id))
    requestAnimationFrame(() =>
      requestAnimationFrame(() => itemRefs.current.get(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    )
  }

  function handleSaved(saved) {
    setEditing(null)
    if (saved?.id) setOpenIds((prev) => new Set(prev).add(saved.id))
    load()
  }

  function handleDeleted() {
    setEditing(null)
    load()
  }

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-narrow app-scroll">
        <FeatureHeader
          filters={
            <div className="reports-search-bar contacts-search-bar">
              <IconSearch size={18} />
              <input
                type="search"
                className="reports-search-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="キーワードで検索（例: 鍵、ブレーカー、セコム）"
                aria-label="キーワードで検索"
              />
              {query && (
                <button type="button" className="reports-search-clear" onClick={() => setQuery('')} aria-label="検索文字をクリア">
                  ×
                </button>
              )}
            </div>
          }
          actions={
            <>
              <button
                type="button"
                className="btn-primary manuals-add-btn"
                onClick={() => setEditing({ kind: tab === 'all' ? 'response' : tab })}
              >
                項目を追加
              </button>
              <button
                type="button"
                className="icon-btn-add manuals-add-icon-btn"
                onClick={() => setEditing({ kind: tab === 'all' ? 'response' : tab })}
                aria-label="項目を追加"
                title="項目を追加"
              >
                ＋
              </button>
            </>
          }
        />

        <div className="manuals-tabs-row">
          <div className="ui-segmented manuals-tabs" role="tablist" aria-label="種類">
            {[{ key: 'all', label: 'すべて' }, ...MANUAL_KINDS].map((k) => (
              <button
                key={k.key}
                type="button"
                role="tab"
                aria-selected={tab === k.key}
                className={`ui-segmented-btn${tab === k.key ? ' is-active' : ''}`}
                onClick={() => setTab(k.key)}
              >
                {k.label}
                <span className="manuals-tab-count">{counts[k.key]}</span>
              </button>
            ))}
          </div>
        </div>

        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : groups.length === 0 ? (
          <p className="ui-empty">
            {manuals.length === 0
              ? '業務マニュアルがまだ登録されていません。'
              : `「${query.trim()}」に当てはまる項目はありません。`}
          </p>
        ) : (
          groups.map((g) => (
            <section key={g.key} className="manuals-group">
              <h3 className="manuals-group-head">
                {g.label}
                <span className="manuals-group-count">{g.rows.length}件</span>
              </h3>
              <ul className="manuals-list">
                {g.rows.map((m) => {
                  const open = Boolean(q) || openIds.has(m.id)
                  const defs = MANUAL_FIELD_DEFS[m.kind] || []
                  const related = (m.related_ids || []).map((id) => byId.get(id)).filter(Boolean)
                  return (
                    <li
                      key={m.id}
                      className={`manuals-item${open ? ' is-open' : ''}`}
                      ref={(el) => (el ? itemRefs.current.set(m.id, el) : itemRefs.current.delete(m.id))}
                    >
                      <button type="button" className="manuals-item-head" onClick={() => toggle(m.id)} aria-expanded={open}>
                        {m.no != null && <span className="manuals-item-no">{m.no}</span>}
                        <span className="manuals-item-title">
                          <Highlight text={m.title} query={query} />
                        </span>
                        <span className="manuals-item-caret" aria-hidden="true">
                          {open ? '▲' : '▼'}
                        </span>
                      </button>
                      {open && (
                        <div className="manuals-item-body">
                          {defs.map((d) =>
                            m.fields?.[d.key] ? (
                              <Fragment key={d.key}>
                                <p className="manuals-field-label">{d.label}</p>
                                <p className="manuals-field-value">
                                  <RichText text={m.fields[d.key]} query={query} />
                                </p>
                              </Fragment>
                            ) : null
                          )}
                          {m.body && (
                            <p className="manuals-field-value">
                              <RichText text={m.body} query={query} />
                            </p>
                          )}
                          {related.length > 0 && (
                            <div className="manuals-related">
                              <span className="manuals-field-label">関連</span>
                              {related.map((r) => (
                                <button key={r.id} type="button" className="manuals-related-link" onClick={() => jumpTo(r.id)}>
                                  {MANUAL_KIND_LABELS[r.kind]}「{r.title}」
                                </button>
                              ))}
                            </div>
                          )}
                          <div className="manuals-item-actions">
                            <button type="button" className="btn-plain" onClick={() => setEditing(m)}>
                              修正
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          ))
        )}
      </div>

      {editing && (
        <ManualForm
          key={editing.id || `new-${editing.kind}`}
          existing={editing.id ? editing : null}
          defaultKind={editing.kind}
          manuals={manuals}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  )
}
