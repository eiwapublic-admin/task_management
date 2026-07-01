import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import KanbanBoard from '../components/KanbanBoard'
import { getCurrentUser, logout } from '../lib/auth'
import { fetchTasks, fetchSettings, updateTaskStatus } from '../lib/tasks'
import { runFetch } from '../lib/api'
import { formatDateTime } from '../lib/format'
import './Dashboard.css'

const DEFAULT_ASSIGNEES = ['橋口', '西川', '岡田']

function parseAssignees(raw) {
  if (!raw) return DEFAULT_ASSIGNEES
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) && arr.length > 0 ? arr : DEFAULT_ASSIGNEES
  } catch {
    return DEFAULT_ASSIGNEES
  }
}

export default function Dashboard() {
  const [tasks, setTasks] = useState([])
  const [assignees, setAssignees] = useState(DEFAULT_ASSIGNEES)
  const [lastFetchAt, setLastFetchAt] = useState(null)
  const [loading, setLoading] = useState(true)
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const navigate = useNavigate()
  const user = getCurrentUser()

  const load = useCallback(async () => {
    setError('')
    try {
      const [taskList, settings] = await Promise.all([fetchTasks(), fetchSettings()])
      setTasks(taskList)
      setAssignees(parseAssignees(settings.assignees))
      setLastFetchAt(settings.last_fetch_at || null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function handleStatusChange(task, status) {
    const prev = tasks
    // 楽観的更新: 先に画面を更新し、失敗したら戻す
    setTasks((list) => list.map((t) => (t.id === task.id ? { ...t, status } : t)))
    try {
      await updateTaskStatus(task.id, status)
    } catch (err) {
      setTasks(prev)
      setError(err.message)
    }
  }

  async function handleRunFetch() {
    setFetching(true)
    setError('')
    setNotice('')
    try {
      const summary = await runFetch()
      if (summary.skipped) {
        setNotice(`スキップ: ${summary.reason}`)
      } else {
        setNotice(
          `取得 ${summary.fetched} 件 / 新規タスク ${summary.created} 件 / 返信検知 ${summary.replied} 件 / 業務外 ${summary.nonBusiness} 件`
        )
        if (summary.errors && summary.errors.length > 0) {
          setError(`一部の処理でエラーが発生しました（${summary.errors.length}件）: ${summary.errors[0]}`)
        }
      }
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setFetching(false)
    }
  }

  function handleLogout() {
    logout()
    navigate('/login')
  }

  return (
    <div className="dashboard-page">
      <header className="dashboard-header">
        <h1>タスク管理システム</h1>
        <div className="dashboard-header-right">
          {lastFetchAt && (
            <span className="dashboard-lastfetch">最終取得: {formatDateTime(lastFetchAt)}</span>
          )}
          <button onClick={handleRunFetch} disabled={fetching}>
            {fetching ? '取得中…' : '今すぐ取得'}
          </button>
          {user && <span className="dashboard-user">{user.display_name} さん</span>}
          <button onClick={() => navigate('/settings')}>設定</button>
          <button onClick={handleLogout}>ログアウト</button>
        </div>
      </header>

      {notice && (
        <p className="dashboard-banner dashboard-notice" role="status" aria-live="polite">
          {notice}
        </p>
      )}
      {error && (
        <p className="dashboard-banner dashboard-error" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p className="dashboard-loading">読み込み中…</p>
      ) : tasks.length === 0 ? (
        <div className="dashboard-empty">
          <p>まだタスクがありません。</p>
          <p className="dashboard-empty-hint">
            「今すぐ取得」を押すと共有メールを取得・分類します。まだ配信が始まったばかりの場合は、
            メールが届いてから取得してください。
          </p>
        </div>
      ) : (
        <KanbanBoard tasks={tasks} assignees={assignees} onStatusChange={handleStatusChange} />
      )}
    </div>
  )
}
