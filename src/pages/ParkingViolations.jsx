import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import { IconHome } from '../components/Icons'
import { fetchParkingViolations, VIOLATION_LABELS, formatReportDate } from '../lib/reports'
import { formatDateTime } from '../lib/format'
import './Dashboard.css'

// 同一ナンバー（地域+番号）の名寄せキー。どちらも未入力なら集計対象外にする
function plateKey(v) {
  if (!v.plate_region && !v.plate_number) return null
  return `${v.plate_region || ''}|${v.plate_number || ''}`
}

// 違反車両一覧。日報入力（各日の日報詳細）とは独立し、日を跨って検索・確認できる画面。
export default function ParkingViolations() {
  const navigate = useNavigate()
  const [violations, setViolations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('date') // 'date'（日付順） | 'rank'（累計回数順）

  useEffect(() => {
    fetchParkingViolations()
      .then(setViolations)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  // 同一ナンバーの累計回数
  const countByPlate = useMemo(() => {
    const map = new Map()
    for (const v of violations) {
      const key = plateKey(v)
      if (!key) continue
      map.set(key, (map.get(key) || 0) + 1)
    }
    return map
  }, [violations])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = violations
    if (q) {
      list = list.filter((v) =>
        [v.plate_region, v.plate_number, v.owner_company, v.maker, v.model, v.note]
          .filter(Boolean)
          .some((s) => s.toLowerCase().includes(q))
      )
    }
    const sorted = [...list]
    if (sort === 'rank') {
      sorted.sort((a, b) => {
        const diff = (countByPlate.get(plateKey(b)) || 0) - (countByPlate.get(plateKey(a)) || 0)
        if (diff !== 0) return diff
        return new Date(b.checked_at) - new Date(a.checked_at)
      })
    } else {
      sorted.sort((a, b) => new Date(b.checked_at) - new Date(a.checked_at))
    }
    return sorted
  }, [violations, query, sort, countByPlate])

  return (
    <div className="reports-page">
      <AppHeader />
      <div className="reports-container">
        <div className="reports-toolbar">
          <button
            type="button"
            className="icon-btn-home"
            onClick={() => navigate('/reports')}
            aria-label="日報一覧に戻る"
            title="日報一覧に戻る"
          >
            <IconHome size={32} />
          </button>
          <h2 className="page-title">違反車両一覧</h2>
        </div>

        <div className="parking-list-controls">
          <input
            type="text"
            className="parking-search"
            placeholder="ナンバー・会社名などで検索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="検索"
          />
          <div className="sort-toggle" role="group" aria-label="並び順">
            <button
              type="button"
              className={`sort-toggle-btn${sort === 'date' ? ' is-active' : ''}`}
              aria-pressed={sort === 'date'}
              onClick={() => setSort('date')}
            >
              日付順
            </button>
            <button
              type="button"
              className={`sort-toggle-btn${sort === 'rank' ? ' is-active' : ''}`}
              aria-pressed={sort === 'rank'}
              onClick={() => setSort('rank')}
            >
              累計回数順
            </button>
          </div>
        </div>

        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : filtered.length === 0 ? (
          <p className="settings-hint">
            {violations.length === 0 ? 'まだ違反車両の記録がありません。' : '該当する記録がありません。'}
          </p>
        ) : (
          <ul className="parking-list">
            {filtered.map((v) => {
              const key = plateKey(v)
              const count = key ? countByPlate.get(key) || 0 : 0
              return (
                <li className="parking-list-row" key={v.id}>
                  <div className="parking-list-main">
                    <span className="parking-list-date">{formatDateTime(v.checked_at)}</span>
                    <span className="parking-list-plate">
                      {v.plate_region || v.plate_number
                        ? `${v.plate_region || ''} ${v.plate_number || ''}`.trim()
                        : '（ナンバー未入力）'}
                    </span>
                    {count > 1 && <span className="parking-list-count">累計{count}回</span>}
                    {v.report_date && (
                      <button
                        type="button"
                        className="parking-list-link"
                        onClick={() => navigate(`/reports/${v.report_date}`)}
                      >
                        {formatReportDate(v.report_date)}の日報を見る
                      </button>
                    )}
                  </div>
                  {(v.maker || v.model || v.owner_company) && (
                    <div className="parking-list-sub">
                      {(v.maker || v.model) && <span>{[v.maker, v.model].filter(Boolean).join(' ')}</span>}
                      {v.owner_company && <span>{v.owner_company}</span>}
                    </div>
                  )}
                  {v.violations.length > 0 && (
                    <div className="parking-list-tags">
                      {v.violations.map((t) => (
                        <span key={t} className="parking-list-tag">
                          {VIOLATION_LABELS[t] || t}
                        </span>
                      ))}
                    </div>
                  )}
                  {v.note && <p className="parking-list-note">{v.note}</p>}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
