import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import TaskDetail from '../components/TaskDetail'
import { fetchArchive, fetchSettings, updateTaskStatus, setTaskSpam } from '../lib/tasks'
import { updateTask } from '../lib/api'
import { createReport, addEntry, todayJST, nowHHMM } from '../lib/reports'
import { formatDate, formatDateTime } from '../lib/format'
import { channelIconSrc, channelLabel, CHANNEL_OPTIONS } from '../lib/channel'
import { formatTaskId } from '../lib/taskId'
import { STATUS_LIST, UNASSIGNED } from '../lib/status'
import useStickyHeightVar from '../lib/useStickyHeightVar'
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
  // タイトル＋絞り込みをAppHeaderの下に固定表示し、表の列見出しはさらにその下に重ねる（2026-08-11）
  const stickyHeadRef = useStickyHeightVar('--sticky2-h')

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

  // タスク詳細の「日報に追加」。当日の日報（未作成なら作成）に、タスクのタイトルを
  // 内容とした作業記録を追加し、日報の該当日入力画面へ遷移する。
  async function handleAddToReport(task) {
    const today = todayJST()
    const report = await createReport(today)
    await addEntry(report.id, {
      entry_time: nowHHMM(),
      content: task.title,
      source_task_id: task.id,
    })
    navigate(`/reports/${today}`)
  }

  const assigneeOptions = Array.from(new Set([...assignees, UNASSIGNED]))

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container logs-container">
        {/* タイトル＋絞り込みはAppHeaderの下に固定表示する（2026-08-11） */}
        <div className="ui-sticky-head" ref={stickyHeadRef}>
        <h2 className="ui-page-title">アーカイブ</h2>
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
        </div>

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
          <table className="logs-table">
            {/* 列見出しはタイトル＋絞り込みの下に重ねて固定表示する（2026-08-11） */}
            <thead>
              <tr>
                <th className="ui-sticky-head-2">情報源</th>
                <th className="ui-sticky-head-2">タスクID</th>
                <th className="ui-sticky-head-2">タイトル</th>
                <th className="ui-sticky-head-2">担当者</th>
                <th className="ui-sticky-head-2">期限</th>
                <th className="ui-sticky-head-2">受信日時</th>
                <th className="ui-sticky-head-2">アーカイブ日</th>
                <th className="ui-sticky-head-2">操作</th>
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
        onAddToReport={handleAddToReport}
      />
    </div>
  )
}
