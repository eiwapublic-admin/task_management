import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchLogs } from '../lib/tasks'
import { formatDateTime } from '../lib/format'
import './Dashboard.css'

const TYPE_LABELS = {
  fetch: 'メール取得',
  status_change: 'ステータス変更',
}

export default function Logs() {
  const navigate = useNavigate()
  const [logs, setLogs] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchLogs()
      .then(setLogs)
      .catch((err) => setError(err.message))
  }, [])

  return (
    <div className="dashboard-page">
      <header className="dashboard-header">
        <div className="dashboard-header-left">
          <h1>操作ログ</h1>
        </div>
        <div className="dashboard-header-right">
          <button
            className="btn-cancel"
            type="button"
            aria-label="カンバンへ戻る"
            title="カンバンへ戻る"
            onClick={() => navigate('/')}
          >
            ×
          </button>
        </div>
      </header>
      <div className="logs-container">
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
              {logs.map((log) => (
                <tr key={log.id}>
                  <td className="logs-time">{formatDateTime(log.created_at)}</td>
                  <td>
                    <span className={`logs-type logs-type-${log.log_type}`}>
                      {TYPE_LABELS[log.log_type] || log.log_type}
                    </span>
                  </td>
                  <td className="logs-actor">{log.actor}</td>
                  <td className="logs-message">{log.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="logs-note">直近200件を表示しています（60日より古いログは自動削除されます）。</p>
      </div>
    </div>
  )
}
