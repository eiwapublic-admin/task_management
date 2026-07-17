import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import TaskDetail from '../components/TaskDetail'
import { fetchArchive, fetchSettings, updateTaskStatus } from '../lib/tasks'
import { updateTask } from '../lib/api'
import { formatDate, formatDateTime } from '../lib/format'
import { channelIcon, channelLabel, CHANNEL_OPTIONS } from '../lib/channel'
import { UNASSIGNED } from '../lib/status'
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

export default function Archive() {
  const navigate = useNavigate()
  const [tasks, setTasks] = useState(null)
  const [error, setError] = useState('')
  const [assignees, setAssignees] = useState(DEFAULT_ASSIGNEES)
  const [sharedGmail, setSharedGmail] = useState('')

  // 絞り込み: 担当者・情報源はその場で反映、フリーワードは検索ボタン/Enterで反映
  const [assignee, setAssignee] = useState('')
  const [channel, setChannel] = useState('')
  const [qInput, setQInput] = useState('')
  const [appliedQ, setAppliedQ] = useState('')

  const [selectedTask, setSelectedTask] = useState(null)

  const load = useCallback(async (filters) => {
    setError('')
    try {
      const list = await fetchArchive(filters)
      setTasks(list)
    } catch (err) {
      setError(err.message)
    }
  }, [])

  useEffect(() => {
    fetchSettings()
      .then((s) => {
        setAssignees(parseAssignees(s.assignees))
        setSharedGmail(s.shared_gmail || '')
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    load({ assignee, channel, q: appliedQ })
  }, [assignee, channel, appliedQ, load])

  function handleSearch(e) {
    e.preventDefault()
    setAppliedQ(qInput.trim())
  }

  function reload() {
    load({ assignee, channel, q: appliedQ })
  }

  // 詳細画面でステータスを変更したら一覧を更新。完了以外に戻すと
  // アーカイブから外れる（サーバー側で archived_at がクリアされる）ため、
  // 一覧から消えるのに合わせてモーダルも閉じる。
  async function handleStatusChange(task, status) {
    try {
      await updateTaskStatus(task.id, status)
      if (status === '完了') {
        setSelectedTask((prev) => (prev && prev.id === task.id ? { ...prev, status } : prev))
      } else {
        setSelectedTask(null)
      }
      reload()
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleUpdateTask(id, values) {
    const res = await updateTask(id, values)
    if (res.task) {
      setSelectedTask((prev) => (prev && prev.id === id ? { ...prev, ...res.task } : prev))
    }
    reload()
    return res.task
  }

  const assigneeOptions = Array.from(new Set([...assignees, UNASSIGNED]))

  return (
    <div className="dashboard-page">
      <header className="dashboard-header">
        <div className="dashboard-header-left">
          <h1>アーカイブ</h1>
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
        <form className="archive-filters" onSubmit={handleSearch}>
          <label className="archive-filter">
            担当者
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">すべて</option>
              {assigneeOptions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <label className="archive-filter">
            情報源
            <select value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="">すべて</option>
              {CHANNEL_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.icon} {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="archive-filter archive-filter-search">
            キーワード検索
            <input
              type="search"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="タイトル・本文・送信者などを全文検索"
            />
          </label>
          <button type="submit" className="archive-search-btn">
            検索
          </button>
        </form>

        {error && (
          <p className="dashboard-banner dashboard-error" role="alert">
            {error}
          </p>
        )}
        {tasks === null ? (
          !error && <p className="dashboard-loading">読み込み中…</p>
        ) : tasks.length === 0 ? (
          <p className="dashboard-loading">該当するアーカイブはありません。</p>
        ) : (
          <table className="logs-table archive-table">
            <thead>
              <tr>
                <th>情報源</th>
                <th>タイトル</th>
                <th>担当者</th>
                <th>期限</th>
                <th>受信日時</th>
                <th>アーカイブ日</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr
                  key={task.id}
                  className="archive-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedTask(task)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setSelectedTask(task)
                    }
                  }}
                >
                  <td className="archive-channel">
                    <span title={channelLabel(task)} aria-label={channelLabel(task)}>
                      {channelIcon(task)}
                    </span>
                  </td>
                  <td className="archive-title">{task.title}</td>
                  <td>{task.assignee}</td>
                  <td>{formatDate(task.due_date) ?? '—'}</td>
                  <td className="logs-time">{formatDateTime(task.received_at) ?? '—'}</td>
                  <td className="logs-time">{formatDateTime(task.archived_at) ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="logs-note">
          「完了」から設定日数を超えたタスクが自動的にアーカイブされます（最新500件・行をタップで詳細表示）。
        </p>
      </div>

      <TaskDetail
        task={selectedTask}
        onClose={() => setSelectedTask(null)}
        onStatusChange={handleStatusChange}
        sharedGmail={sharedGmail}
        assignees={assignees}
        onUpdateTask={handleUpdateTask}
      />
    </div>
  )
}
