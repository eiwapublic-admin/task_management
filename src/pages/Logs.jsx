import { useEffect, useState } from 'react'
import AppHeader from '../components/AppHeader'
import { fetchLogs } from '../lib/tasks'
import { formatDateTime } from '../lib/format'
import './Dashboard.css'

const TYPE_LABELS = {
  fetch: 'メール取得',
  status_change: 'ステータス変更',
}

// タイムスタンプを JST の 'YYYY-MM-DD' にする（日の切り替わり判定用）
function jstDate(value) {
  return new Date(value).toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
}

export default function Logs() {
  const [logs, setLogs] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchLogs()
      .then(setLogs)
      .catch((err) => setError(err.message))
  }, [])

  return (
    <div className="dashboard-page">
      <AppHeader />
      <div className="logs-container">
        <h2 className="page-title">処理ログ</h2>
        {error && (
          <p className="dashboard-banner dashboard-error" role="alert">
            {error}
          </p>
        )}
        {logs === null ? (
          !error && <p className="dashboard-loading">読み込み中…</p>
        ) : logs.length === 0 ? (
          <p className="dashboard-loading">まだログがありません。</p>
        ) : (
          <table className="logs-table">
            <thead>
              <tr>
                <th>日時</th>
                <th>種別</th>
                <th>実行者</th>
                <th>内容</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log, i) => {
                // JST の日付が前の行と変わる位置に太い区切りを入れる（新しい順のため隣接比較）
                const day = jstDate(log.created_at)
                const isDayBoundary = i === 0 || day !== jstDate(logs[i - 1].created_at)
                return (
                <tr key={log.id} className={isDayBoundary ? 'logs-day-boundary' : undefined}>
                  <td className="logs-time">{formatDateTime(log.created_at)}</td>
                  <td>
                    <span className={`logs-type logs-type-${log.log_type}`}>
                      {TYPE_LABELS[log.log_type] || log.log_type}
                    </span>
                  </td>
                  <td className="logs-actor">{log.actor}</td>
                  <td className="logs-message">{log.message}</td>
                </tr>
                )
              })}
            </tbody>
          </table>
        )}
        <p className="logs-note">直近200件を表示しています（60日より古いログは自動削除されます）。</p>
      </div>
    </div>
  )
}
