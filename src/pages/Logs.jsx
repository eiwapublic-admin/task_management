import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import { IconChevronRight, IconRefresh } from '../components/Icons'
import { fetchLogs } from '../lib/tasks'
import { formatDateTime } from '../lib/format'
import { LEVEL_LABELS, fetchAdminAlerts, markAlertsSeen } from '../lib/alerts'
import './Dashboard.css'

// 種目。2026-11-25 から「エラー」は種目ではなくステータス（E）で表す。
// 以前 'error' 種目で記録していた分は DB 側で fetch／system へ移した（切り替え中に書かれた
// 'error' の行は「システム」として表示・絞り込みする）
const TYPE_LABELS = {
  fetch: 'メール取得',
  status_change: 'ステータス変更',
  backup: 'バックアップ',
  system: 'システム',
}
const typeOf = (log) => (log.log_type === 'error' ? 'system' : log.log_type)
const levelOf = (log) => log.level || (log.log_type === 'error' ? 'E' : 'I')

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
  // ステータス絞り込み（2026-11-25）。null = すべて、'WE' = 警告とエラー、'E' = エラーのみ
  const [levelFilter, setLevelFilter] = useState(null)
  // 「確認済みにする」以降の未確認の警告・エラー件数
  const [unseen, setUnseen] = useState(null)
  // 日グループの開閉状態。ユーザーが手で切り替えた分だけ既定値からの例外として持つ
  // （残留塩素等検査の年月グループと同じやり方。Chlorine.jsx参照）
  const [collapseOverrides, setCollapseOverrides] = useState({})
  // 再読み込み中フラグ（2026-08-27）。既存の一覧は残したまま更新するので、
  // 読み込み中表示（logs === null の分岐）は使わずボタン側の見た目だけで進行中を示す。
  const [reloading, setReloading] = useState(false)

  const load = useCallback(() => {
    setReloading(true)
    setError('')
    fetchAdminAlerts()
      .then((r) => setUnseen(r.unseen || null))
      .catch(() => setUnseen(null))
    return fetchLogs()
      .then(setLogs)
      .catch((err) => setError(err.message))
      .finally(() => setReloading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const filteredLogs = useMemo(() => {
    if (!logs) return logs
    return logs.filter((log) => {
      if (typeFilter && typeOf(log) !== typeFilter) return false
      if (levelFilter && !levelFilter.includes(levelOf(log))) return false
      return true
    })
  }, [logs, typeFilter, levelFilter])

  async function handleSeen() {
    try {
      await markAlertsSeen()
      setUnseen({ errors: 0, warnings: 0 })
    } catch (err) {
      setError(err.message)
    }
  }
  const unseenCount = unseen ? (unseen.errors || 0) + (unseen.warnings || 0) : 0

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
      <div className="ui-container logs-container app-scroll">
        {/* 画面名はアプリヘッダが出すので、ここに見出し行は置かない（2026-08-12） */}
        <FeatureHeader
          filters={
            <>
            <div className="filter-bar" role="group" aria-label="ステータスで絞り込み">
              <span className="filter-bar-label">ステータス:</span>
              {[
                [null, 'すべて'],
                ['WE', '警告・エラー'],
                ['E', 'エラーのみ'],
              ].map(([value, label]) => (
                <button
                  key={label}
                  className={levelFilter === value ? 'filter-chip active' : 'filter-chip'}
                  aria-pressed={levelFilter === value}
                  onClick={() => setLevelFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
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
            </>
          }
          actions={
            <button
              type="button"
              className={`icon-btn-refresh${reloading ? ' is-loading' : ''}`}
              onClick={load}
              disabled={reloading}
              aria-label="再読み込み"
              title="再読み込み"
            >
              <IconRefresh size={20} />
            </button>
          }
        />
        {error && (
          <p className="dashboard-banner dashboard-error" role="alert">
            {error}
          </p>
        )}
        {unseenCount > 0 && (
          <div className="logs-unseen" role="status">
            <span>
              未確認の
              {unseen.errors > 0 && <strong className="logs-unseen-e">エラー {unseen.errors} 件</strong>}
              {unseen.errors > 0 && unseen.warnings > 0 && '・'}
              {unseen.warnings > 0 && <strong className="logs-unseen-w">警告 {unseen.warnings} 件</strong>}
              があります。
            </span>
            <span className="logs-unseen-actions">
              <button type="button" className="btn-plain" onClick={() => setLevelFilter('WE')}>
                警告・エラーだけ表示
              </button>
              <button type="button" className="btn-primary" onClick={handleSeen}>
                確認済みにする
              </button>
            </span>
          </div>
        )}
        {logs === null ? (
          !error && <p className="dashboard-loading">読み込み中…</p>
        ) : filteredLogs.length === 0 ? (
          <p className="dashboard-loading">{typeFilter || levelFilter ? '該当するログがありません。' : 'まだログがありません。'}</p>
        ) : (
          <div className="logs-table-wrap">
          <table className="ui-table logs-table">
            <thead>
              <tr>
                <th>日時</th>
                <th>ステータス</th>
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
                      <td colSpan={5}>
                        <span className="logs-day-head-inner">
                          <IconChevronRight size={16} className={`logs-day-toggle-icon${open ? ' is-open' : ''}`} />
                          <span className="logs-day-label">{jstDateLabel(g.day)}</span>
                          <span className="logs-day-count">{g.rows.length}件</span>
                        </span>
                      </td>
                    </tr>
                    {open &&
                      g.rows.map((log) => (
                        <tr key={log.id} className={`logs-row-${levelOf(log)}`}>
                          <td className="logs-time">{formatDateTime(log.created_at)}</td>
                          <td>
                            <span className={`logs-level logs-level-${levelOf(log)}`} title={LEVEL_LABELS[levelOf(log)]}>
                              {levelOf(log)}:{LEVEL_LABELS[levelOf(log)]}
                            </span>
                          </td>
                          <td>
                            <span className={`logs-type logs-type-${typeOf(log)}`}>
                              {TYPE_LABELS[typeOf(log)] || log.log_type}
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
