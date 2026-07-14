import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import KanbanBoard from '../components/KanbanBoard'
import { getCurrentUser, logout } from '../lib/auth'
import { fetchTasks, fetchSettings, updateTaskStatus, logStatusChange } from '../lib/tasks'
import { runFetch, createTask, updateTask } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { BILLING_URL } from '../lib/pricing'
import { reloadApp } from '../pwa/reloadApp'
import { formatBuildTime } from '../lib/version'
import './Dashboard.css'

// バックエンドの取り込み処理を画面に反映するための自動更新間隔（ミリ秒）。
// 取得処理の完了を正確に検知するのは難しいため、一定間隔での再取得と
// タブ復帰時の再取得で最新状態に追従する。
const AUTO_REFRESH_MS = 5 * 60 * 1000

// settings.api_credit_alert（JSON文字列 or 空）を解釈してメッセージを返す
function parseCreditAlert(raw) {
  if (!raw) return null
  try {
    const obj = JSON.parse(raw)
    return obj.message || 'APIクレジットが不足している可能性があります。'
  } catch {
    return String(raw)
  }
}

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
  const [creditAlert, setCreditAlert] = useState(null)
  const [sharedGmail, setSharedGmail] = useState('')
  const navigate = useNavigate()
  const user = getCurrentUser()
  // 楽観的更新中のステータス書き込み件数。0 より大きい間は自動更新をスキップし、
  // 未確定の変更が背景の再取得で巻き戻されるのを防ぐ。
  const pendingWrites = useRef(0)

  const load = useCallback(async ({ silent = false } = {}) => {
    // 手動反映（silent=false）以外ではエラー表示をクリアしない
    if (!silent) setError('')
    try {
      const [taskList, settings] = await Promise.all([fetchTasks(), fetchSettings()])
      setTasks(taskList)
      setAssignees(parseAssignees(settings.assignees))
      setLastFetchAt(settings.last_fetch_at || null)
      setCreditAlert(parseCreditAlert(settings.api_credit_alert))
      setSharedGmail(settings.shared_gmail || '')
    } catch (err) {
      if (!silent) setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 自動更新: 一定間隔での再取得 + タブ復帰時の再取得（C2）。
  // 未確定のステータス変更がある間や手動取得中はスキップする。
  useEffect(() => {
    function silentRefresh() {
      if (pendingWrites.current > 0) return
      if (document.hidden) return
      load({ silent: true })
    }
    const timer = setInterval(silentRefresh, AUTO_REFRESH_MS)
    function onVisible() {
      if (!document.hidden) silentRefresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  async function handleStatusChange(task, status) {
    const prev = tasks
    // 楽観的更新: 先に画面を更新し、失敗したら戻す
    setTasks((list) => list.map((t) => (t.id === task.id ? { ...t, status } : t)))
    pendingWrites.current += 1
    try {
      await updateTaskStatus(task.id, status)
      // ログの記録失敗はステータス変更自体には影響させない
      logStatusChange(task, task.status, status, user?.display_name).catch(() => {})
    } catch (err) {
      setTasks(prev)
      setError(err.message)
    } finally {
      pendingWrites.current -= 1
    }
  }

  // タスクの手動登録（未処理列の「＋」から）。登録後に一覧を再取得する。
  async function handleCreateTask(values) {
    const res = await createTask(values)
    await load()
    return res.task
  }

  // 詳細画面での担当者・期限・留意事項の編集保存。更新後のタスクを返す。
  async function handleUpdateTask(id, values) {
    const res = await updateTask(id, values)
    // 楽観的にローカルへ反映しつつ、確定値で一覧を再取得する
    if (res.task) {
      setTasks((list) => list.map((t) => (t.id === id ? { ...t, ...res.task } : t)))
    }
    load({ silent: true })
    return res.task
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
          `取得 ${summary.fetched} 件 / 新規タスク ${summary.created} 件 / 返信検知 ${summary.replied} 件 / 業務外 ${summary.nonBusiness} 件 / カレンダー登録 ${summary.calendarCreated ?? 0} 件`
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
        <div className="dashboard-header-left">
          <button
            type="button"
            className="dashboard-logo-button"
            onClick={() => reloadApp()}
            aria-label="最新の状態に更新"
            title="タップで最新の状態に更新"
            style={{ touchAction: 'manipulation' }}
          >
            <img className="dashboard-logo" src="/logo.svg" alt="栄和ロゴ" />
          </button>
          <div className="dashboard-title-wrap">
            <h1>栄和　タスク管理システム</h1>
            <span className="dashboard-version">ver.{formatBuildTime()}</span>
          </div>
        </div>
        <div className="dashboard-header-right">
          {lastFetchAt && (
            <span className="dashboard-lastfetch">最終取得: {formatDateTime(lastFetchAt)}</span>
          )}
          <button onClick={handleRunFetch} disabled={fetching}>
            {fetching ? '取得中…' : '今すぐ取得'}
          </button>
          <button onClick={() => navigate('/logs')}>ログ</button>
          <button className="btn-settings" onClick={() => navigate('/settings')}>設定</button>
          <button className="btn-logout" onClick={handleLogout}>ログアウト</button>
        </div>
      </header>

      {creditAlert && (
        <div className="dashboard-banner dashboard-credit-alert" role="alert">
          <span>
            ⚠️ APIクレジットが不足し、メールの自動分類が停止しています。チャージ後に「今すぐ取得」で再開できます。
          </span>
          <a
            className="dashboard-credit-button"
            href={BILLING_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            APIクレジットをチャージ
          </a>
        </div>
      )}
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
        <KanbanBoard
          tasks={tasks}
          assignees={assignees}
          onStatusChange={handleStatusChange}
          onCreateTask={handleCreateTask}
          onUpdateTask={handleUpdateTask}
          userName={user?.display_name}
          sharedGmail={sharedGmail}
        />
      )}
    </div>
  )
}
