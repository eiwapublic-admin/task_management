import { Fragment, useEffect, useMemo, useState } from 'react'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import { IconChevronRight } from '../components/Icons'
import { fetchLogs } from '../lib/tasks'
import { formatDateTime } from '../lib/format'
import './Dashboard.css'

const TYPE_LABELS = {
  fetch: 'メール取得',
  status_change: 'ステータス変更',
}

// タイムスタンプを JST の 'YYYY-MM-DD' にする（日ごとのグルーピング用）
function jstDate(value) {
  return new Date(value).toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
}

// 'YYYY-MM-DD' を見出し表示用に整形する（例: 2026年8月17日(月)）
function jstDateLabel(day) {
  const d = new Date(`${day}T00:00:00+09:00`)
  return d.toLocaleDateString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  })
}

export default function Logs() {
  const [logs, setLogs] = useState(null)
  const [error, setError] = useState('')
  // 種別フィルタ（2026-08-17）。null = すべて
  const [typeFilter, setTypeFilter] = useState(null)
  // 日グループの開閉状態。ユーザーが手で切り替えた分だけ既定値からの例外として持つ
  // （残留塩素等検査の年月グループと同じやり方。Chlorine.jsx参照）
  const [collapseOverrides, setCollapseOverrides] = useState({})

  useEffect(() => {
    fetchLogs()
      .then(setLogs)
      .catch((err) => setError(err.message))
  }, [])

  const filteredLogs = useMemo(() => {
    if (!logs) return logs
    return typeFilter ? logs.filter((log) => log.log_type === typeFilter) : logs
  }, [logs, typeFilter])

  // 日ごとにまとめる（新しい日が上。ログ自体が新しい順で来るので並び替えは不要）
  const groups = useMemo(() => {
    if (!filteredLogs) return []
    const map = new Map()
    for (const log of filteredLogs) {
      const day = jstDate(log.created_at)
      if (!map.has(day)) map.set(day, [])
      map.get(day).push(log)
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, rows]) => ({ day, rows }))
  }, [filteredLogs])

  // 直近7日は既定で開き、それより古い日は既定で閉じる（2026-08-17）
  const recentThreshold = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() - 7)
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
  }, [])
  function isDayOpen(day) {
    const override = collapseOverrides[day]
    if (override !== undefined) return override
    return day >= recentThreshold
  }
  function toggleDay(day) {
    setCollapseOverrides((prev) => ({ ...prev, [day]: !isDayOpen(day) }))
  }

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container logs-container">
        {/* 画面名はアプリヘッダが出すので、ここに見出し行は置かない（2026-08-12） */}
        <FeatureHeader
          filters={
            <div className="filter-bar" role="group" aria-label="種別で絞り込み">
              <span className="filter-bar-label">種別:</span>
              <button
                className={typeFilter === null ? 'filter-chip active' : 'filter-chip'}
                aria-pressed={typeFilter === null}
                onClick={() => setTypeFilter(null)}
              >
                すべて
              </button>
              {Object.entries(TYPE_LABELS).map(([type, label]) => (
                <button
                  key={type}
                  className={typeFilter === type ? 'filter-chip active' : 'filter-chip'}
                  aria-pressed={typeFilter === type}
                  onClick={() => setTypeFilter(type)}
                >
                  {label}
                </button>
              ))}
            </div>
          }
        />
        {error && (
          <p className="dashboard-banner dashboard-error" role="alert">
            {error}
          </p>
        )}
        {logs === null ? (
          !error && <p className="dashboard-loading">読み込み中…</p>
        ) : filteredLogs.length === 0 ? (
          <p className="dashboard-loading">{typeFilter ? '該当するログがありません。' : 'まだログがありません。'}</p>
        ) : (
          <div className="logs-table-wrap">
          <table className="ui-table logs-table">
            <thead>
              <tr>
                <th>日時</th>
                <th>種別</th>
                <th>実行者</th>
                <th>内容</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const open = isDayOpen(g.day)
                return (
                  <Fragment key={g.day}>
                    <tr
                      className="logs-day-head"
                      onClick={() => toggleDay(g.day)}
                      role="button"
                      tabIndex={0}
                      aria-expanded={open}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          toggleDay(g.day)
                        }
                      }}
                    >
                      <td colSpan={4}>
                        <span className="logs-day-head-inner">
                          <IconChevronRight size={16} className={`logs-day-toggle-icon${open ? ' is-open' : ''}`} />
                          <span className="logs-day-label">{jstDateLabel(g.day)}</span>
                          <span className="logs-day-count">{g.rows.length}件</span>
                        </span>
                      </td>
                    </tr>
                    {open &&
                      g.rows.map((log) => (
                        <tr key={log.id}>
                          <td className="logs-time">{formatDateTime(log.created_at)}</td>
                          <td>
                            <span className={`logs-type logs-type-${log.log_type}`}>
                              {TYPE_LABELS[log.log_type] || log.log_type}
                            </span>
                          </td>
                          <td className="logs-actor">{log.actor}</td>
                          <td>{log.message}</td>
                        </tr>
                      ))}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
          </div>
        )}
        <p className="logs-note">直近200件を表示しています（60日より古いログは自動削除されます）。</p>
      </div>
    </div>
  )
}
