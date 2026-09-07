import { useState } from 'react'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import ConfirmDeleteButton from './ConfirmDeleteButton'
import { createReminder, updateReminder, deleteReminder } from '../lib/reminders'
import { formatDateWithWeekday } from '../lib/format'

// 通知時刻の既定値（2026-09-07。依頼）
const DEFAULT_NOTIFY_TIME = '10:00'

// 期限日付から通知タイミングの初期値を自動で提案する（1回目=1週間前、2回目=前日。
// 2026-09-07に変更。あくまで入力の手間を減らすための初期値で、保存前にいつでも変更できる）。
function suggestNotifyDates(dueDateStr) {
  const due = new Date(`${dueDateStr}T00:00:00`)
  if (Number.isNaN(due.getTime())) return { notify1: '', notify2: '' }
  const toDate = (daysBefore) => {
    const d = new Date(due)
    d.setDate(d.getDate() - daysBefore)
    return d.toISOString().slice(0, 10)
  }
  return { notify1: toDate(7), notify2: toDate(1) }
}

// 日付＋曜日をまとめて「yyyy/mm/dd（曜）」で表示する日付欄（2026-09-07）。ネイティブの
// <input type="date">はブラウザ・ロケール依存の表示になり曜日も出せないため、実際の
// 操作（タップでピッカーを開く・キーボード入力）は透明化した<input type="date">に任せ、
// 見た目は自前で組み立てた文字列を上に重ねる（カスタム日付欄の一般的な実装手法）
function DateField({ value, onChange, label }) {
  return (
    <div className="reminder-date-field">
      <input
        type="date"
        className="reminder-date-native"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
      />
      <div className={`ui-input reminder-date-display${value ? '' : ' is-empty'}`}>
        {value ? formatDateWithWeekday(value) : '日付を選択'}
      </div>
    </div>
  )
}

// リマインダーの追加・編集モーダル（2026-09-07〜）。ContactForm と同じ ui-overlay/ui-modal の
// 標準レイアウトに合わせる。
export default function ReminderForm({ existing, onClose, onSaved, onDeleted }) {
  useBodyScrollLock()

  const [title, setTitle] = useState(existing?.title || '')
  const [dueDate, setDueDate] = useState(existing?.due_date || '')
  const [notify1, setNotify1] = useState(existing?.notify_date_1 || '')
  const [notify1Time, setNotify1Time] = useState(existing?.notify_time_1?.slice(0, 5) || DEFAULT_NOTIFY_TIME)
  const [notify2, setNotify2] = useState(existing?.notify_date_2 || '')
  const [notify2Time, setNotify2Time] = useState(existing?.notify_time_2?.slice(0, 5) || DEFAULT_NOTIFY_TIME)
  const [detail, setDetail] = useState(existing?.detail || '')
  const [howTo, setHowTo] = useState(existing?.how_to || '')
  const [done, setDone] = useState(existing?.done || false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // 期限日付を初めて入力したとき、通知タイミングが空欄なら自動で埋める（新規登録時のみ。
  // 時刻は既定の10:00のまま変えない）
  function handleDueDateChange(value) {
    setDueDate(value)
    if (!existing && !notify1 && !notify2 && value) {
      const suggested = suggestNotifyDates(value)
      setNotify1(suggested.notify1)
      setNotify2(suggested.notify2)
    }
  }

  async function handleSave() {
    setError('')
    if (!title.trim()) return setError('タイトルは必須です')
    if (!dueDate) return setError('期限日付は必須です')
    if (!notify1) return setError('通知タイミング（1回目）は必須です')

    setSaving(true)
    try {
      const payload = {
        title: title.trim(),
        due_date: dueDate,
        notify_date_1: notify1,
        notify_time_1: notify1Time || DEFAULT_NOTIFY_TIME,
        notify_date_2: notify2 || null,
        notify_time_2: notify2 ? notify2Time || DEFAULT_NOTIFY_TIME : null,
        detail: detail.trim() || null,
        how_to: howTo.trim() || null,
        done,
      }
      const saved = existing ? await updateReminder(existing.id, payload) : await createReminder(payload)
      onSaved(saved)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  async function handleDelete() {
    try {
      await deleteReminder(existing.id)
      onDeleted(existing.id)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="ui-overlay is-nested" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="ui-modal is-sm" onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h3 className="ui-modal-title">{existing ? existing.title : 'リマインダーを追加'}</h3>
          <button type="button" className="icon-btn-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>

        <div className="ui-modal-body is-stacked">
          {error && (
            <p className="dashboard-error dashboard-banner" role="alert">
              {error}
            </p>
          )}

          <label className="ui-field">
            <span>タイトル</span>
            <input
              type="text"
              className="ui-input"
              placeholder="例: Anthropic APIキーの更新"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>

          <label className="ui-field">
            <span>期限日付</span>
            <DateField value={dueDate} onChange={handleDueDateChange} label="期限日付" />
          </label>

          <div className="report-fields is-halves reminder-notify-fields">
            <label className="ui-field">
              <span>通知タイミング（1回目）</span>
              <div className="reminder-notify-row">
                <DateField value={notify1} onChange={setNotify1} label="通知タイミング（1回目）の日付" />
                <input
                  type="time"
                  className="ui-input reminder-notify-time-input"
                  value={notify1Time}
                  onChange={(e) => setNotify1Time(e.target.value)}
                />
              </div>
            </label>
            <label className="ui-field">
              <span>通知タイミング（2回目・任意）</span>
              <div className="reminder-notify-row">
                <DateField value={notify2} onChange={setNotify2} label="通知タイミング（2回目）の日付" />
                <input
                  type="time"
                  className="ui-input reminder-notify-time-input"
                  value={notify2Time}
                  onChange={(e) => setNotify2Time(e.target.value)}
                />
              </div>
            </label>
          </div>

          <label className="ui-field">
            <span>詳細</span>
            <textarea
              className="ui-textarea"
              rows={3}
              placeholder="何のための作業か、なぜ必要かを書いておく"
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
            />
          </label>

          <label className="ui-field">
            <span>対応の要領</span>
            <textarea
              className="ui-textarea"
              rows={4}
              placeholder="実際に対応するときの手順をメモしておく"
              value={howTo}
              onChange={(e) => setHowTo(e.target.value)}
            />
          </label>

          {existing && (
            <label className="reminder-check-field">
              <input type="checkbox" checked={done} onChange={(e) => setDone(e.target.checked)} />
              対応済み
            </label>
          )}
        </div>

        <div className="ui-modal-foot">
          <div className="ui-modal-foot-start">
            {existing && <ConfirmDeleteButton onConfirm={handleDelete} label="このリマインダーを削除" size={22} />}
          </div>
          <div className="ui-modal-foot-end">
            <button type="button" className="btn-plain" onClick={onClose}>
              キャンセル
            </button>
            <button type="button" className="btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? '保存中…' : '保存する'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
