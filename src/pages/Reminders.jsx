import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import ReminderForm from '../components/ReminderForm'
import { IconBell } from '../components/Icons'
import { fetchReminders, fetchReminder, setReminderDone } from '../lib/reminders'
import { dueStatus, formatDateWithWeekday } from '../lib/format'
import './Dashboard.css'
import './Reminders.css'

// リマインダー画面（2026-09-07〜）。システム運用上、期限のある作業（APIキー更新・
// 年次バックアップ復元ドリル等）を「思い出せる自信がない」件への対応。指定した通知
// タイミングでWeb Pushが届き、通知をタップするとこの画面の該当行が直接開く
// （ルート /reminders/:id。ReportList.jsx の /reports/:date と同じ考え方）。

// 一覧表示用。日付は曜日付きにし、時刻は 'HH:MM:SS' で来るので 'HH:MM' に切り詰める
function formatNotify(date, time) {
  if (!date) return ''
  return `${formatDateWithWeekday(date)} ${(time || '').slice(0, 5)}`
}
export default function Reminders() {
  const navigate = useNavigate()
  const { id: openId } = useParams()
  const [reminders, setReminders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null) // null | 'new' | reminder

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setReminders(await fetchReminders())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 通知からのジャンプ（/reminders/:id）。一覧に既に入っていればそれを開き、
  // 入っていなければ単体取得する（一覧の読み込み待ちを挟まず素早く開くため）
  useEffect(() => {
    if (!openId) return
    const hit = reminders.find((r) => r.id === openId)
    if (hit) {
      setEditing(hit)
      return
    }
    fetchReminder(openId)
      .then((r) => setEditing(r))
      .catch((err) => setError(err.message))
    // reminders の更新のたびに再実行する必要はない（初回のジャンプだけで良い）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId])

  function closeEditing() {
    setEditing(null)
    if (openId) navigate('/reminders')
  }

  function handleSaved() {
    closeEditing()
    load()
  }

  function handleDeleted() {
    closeEditing()
    load()
  }

  async function handleToggleDone(reminder, e) {
    e.stopPropagation()
    try {
      await setReminderDone(reminder.id, !reminder.done)
      load()
    } catch (err) {
      setError(err.message)
    }
  }

  // 未対応を先に、期限日の近い順に並べる
  const sorted = useMemo(() => {
    return [...reminders].sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1
      return a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0
    })
  }, [reminders])

  const groups = useMemo(() => {
    const pending = sorted.filter((r) => !r.done)
    const done = sorted.filter((r) => r.done)
    const out = []
    if (pending.length > 0) out.push({ name: '未対応', rows: pending })
    if (done.length > 0) out.push({ name: '対応済み', rows: done })
    return out
  }, [sorted])

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-narrow app-scroll">
        <FeatureHeader
          actions={
            <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
              リマインダーを追加
            </button>
          }
        />

        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : reminders.length === 0 ? (
          <p className="ui-empty">
            リマインダーはまだ登録されていません。システム運用上、期限のある作業（APIキーの
            更新・年次のバックアップ復元ドリル等）を登録しておくと、通知が届いて思い出せます。
          </p>
        ) : (
          <div className="ui-table-wrap">
            <table className="ui-table reminders-table">
              <thead>
                <tr>
                  <th>タイトル</th>
                  <th>期限日付</th>
                  <th>通知タイミング</th>
                  <th aria-label="対応済み切替" />
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <Fragment key={g.name}>
                    <tr>
                      <td colSpan={4} className="ui-table-group-head">
                        {g.name}
                      </td>
                    </tr>
                    {g.rows.map((r) => {
                      const due = !r.done ? dueStatus(r.due_date) : null
                      return (
                        <tr
                          key={r.id}
                          className={`reminder-row${r.done ? ' is-done' : ''}`}
                          onClick={() => setEditing(r)}
                        >
                          <td className="reminder-title-cell">
                            <IconBell size={16} />
                            {r.title}
                          </td>
                          <td className="reminder-due-cell">
                            {formatDateWithWeekday(r.due_date)}
                            {due?.label && <span className={`reminder-due-flag due-${due.level}`}>{due.label}</span>}
                          </td>
                          <td className="reminder-notify-cell">
                            {formatNotify(r.notify_date_1, r.notify_time_1)}
                            {r.notify_date_2 ? ` / ${formatNotify(r.notify_date_2, r.notify_time_2)}` : ''}
                          </td>
                          <td className="reminder-toggle-cell" onClick={(e) => e.stopPropagation()}>
                            <button type="button" className="btn-plain" onClick={(e) => handleToggleDone(r, e)}>
                              {r.done ? '未対応に戻す' : '対応済みにする'}
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <ReminderForm
          key={editing === 'new' ? 'new' : editing.id}
          existing={editing === 'new' ? null : editing}
          onClose={closeEditing}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  )
}
