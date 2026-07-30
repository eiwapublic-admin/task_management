import { useCallback, useEffect, useState } from 'react'
import AppHeader from '../components/AppHeader'
import TaskDetail from '../components/TaskDetail'
import { fetchArchive, fetchSettings, updateTaskStatus, setTaskSpam } from '../lib/tasks'
import { updateTask } from '../lib/api'
import { formatDate, formatDateTime } from '../lib/format'
import { channelIconSrc, channelLabel, CHANNEL_OPTIONS } from '../lib/channel'
import { formatTaskId } from '../lib/taskId'
import { STATUS_LIST, UNASSIGNED } from '../lib/status'
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

  // スパム判定だけを外す。アーカイブ済みであることは変えない（誤判定の訂正が目的で、
  // カンバンへ戻すかどうかは別途「復帰」で選べるようにするため）。
  async function handleUnspam(task) {
    try {
      await setTaskSpam(task.id, false)
      setSelectedTask((prev) => (prev && prev.id === task.id ? { ...prev, is_spam: false } : prev))
      reload()
    } catch (err) {
      setError(err.message)
    }
  }

  // アーカイブから任意のステータスへ復帰させる。完了以外に変更すると
  // サーバー側で completed_at・archived_at がクリアされ、カンバンに戻る。
  // スパム判定が付いたままだと復帰後もスパム扱いになるので同時に外す。
  async function handleRestore(task, status) {
    try {
      if (task.is_spam) await setTaskSpam(task.id, false)
      await updateTaskStatus(task.id, status)
      setSelectedTask((prev) => (prev && prev.id === task.id ? null : prev))
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
      <AppHeader />
      <div className="logs-container">
        <h2 className="page-title">アーカイブ</h2>
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
                <th>タスクID</th>
                <th>タイトル</th>
                <th>担当者</th>
                <th>期限</th>
                <th>受信日時</th>
                <th>アーカイブ日</th>
                <th>操作</th>
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
                    <img
                      src={channelIconSrc(task)}
                      alt={channelLabel(task)}
                      title={channelLabel(task)}
                    />
                  </td>
                  <td className="archive-task-id">{formatTaskId(task) || '—'}</td>
                  <td className="archive-title">
                    {task.is_spam && <span className="archive-spam-badge">スパム</span>}
                    {task.title}
                  </td>
                  <td>{task.assignee}</td>
                  <td>{formatDate(task.due_date) ?? '—'}</td>
                  <td className="logs-time">{formatDateTime(task.received_at) ?? '—'}</td>
                  <td className="logs-time">{formatDateTime(task.archived_at) ?? '—'}</td>
                  {/* 行タップで詳細が開くため、操作セル内のクリックは伝播させない */}
                  <td
                    className="archive-actions"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    {task.is_spam && (
                      <button
                        type="button"
                        className="archive-action-btn"
                        onClick={() => handleUnspam(task)}
                        title="スパム判定を外す（アーカイブには残ります）"
                      >
                        スパム解除
                      </button>
                    )}
                    {/* 任意のステータスへ復帰。完了以外を選ぶとサーバー側で
                        archived_at がクリアされ、カンバンへ戻る。 */}
                    <select
                      className="archive-action-select"
                      value=""
                      onChange={(e) => {
                        const next = e.target.value
                        e.target.value = ''
                        if (next) handleRestore(task, next)
                      }}
                      aria-label={`${task.title} のステータスを変更して復帰`}
                    >
                      <option value="">復帰…</option>
                      {STATUS_LIST.filter((s) => s !== '完了').map((s) => (
                        <option key={s} value={s}>
                          {s}へ戻す
                        </option>
                      ))}
                    </select>
                  </td>
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
        onUnspam={handleUnspam}
      />
    </div>
  )
}
