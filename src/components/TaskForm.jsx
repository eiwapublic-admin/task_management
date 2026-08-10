import { useEffect, useRef, useState } from 'react'
import { UNASSIGNED } from '../lib/status'
import useBodyScrollLock from '../lib/useBodyScrollLock'

// タスクの手動登録フォーム（モーダル）。
// 未処理列の「＋」ボタンから開き、タイトル・担当者・期限・留意事項を入力して登録する。
export default function TaskForm({ assignees, onClose, onCreate }) {
  const modalRef = useRef(null)
  const [title, setTitle] = useState('')
  const [assignee, setAssignee] = useState(UNASSIGNED)
  const [dueDate, setDueDate] = useState('')
  const [remarks, setRemarks] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useBodyScrollLock()

  useEffect(() => {
    modalRef.current?.querySelector('input, textarea, select')?.focus()
    function handleKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  async function handleSubmit(e) {
    e.preventDefault()
    if (!title.trim()) {
      setError('タイトルを入力してください')
      return
    }
    setSaving(true)
    setError('')
    try {
      await onCreate({
        title: title.trim(),
        assignee,
        due_date: dueDate || null,
        remarks: remarks.trim() || null,
      })
      onClose()
    } catch (err) {
      setError(err.message || '登録に失敗しました')
      setSaving(false)
    }
  }

  return (
    <div className="task-detail-overlay" onClick={onClose}>
      <div
        className="task-detail-modal task-form-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-form-title"
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="task-detail-header">
          <h2 id="task-form-title">タスクを手動で登録</h2>
          <button className="task-detail-close" onClick={onClose} aria-label="閉じる" type="button">
            ×
          </button>
        </div>

        <form className="task-form" onSubmit={handleSubmit}>
          <label className="task-form-field">
            <span className="task-form-label">タイトル（必須）</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              placeholder="タスクの内容がひと目で分かるタイトル"
            />
          </label>

          <label className="task-form-field">
            <span className="task-form-label">担当者</span>
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value={UNASSIGNED}>{UNASSIGNED}</option>
              {assignees.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>

          <label className="task-form-field">
            <span className="task-form-label">期限</span>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </label>

          <label className="task-form-field">
            <span className="task-form-label">留意事項</span>
            <textarea
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              rows={3}
              placeholder="対応時に留意すべき事項があれば入力してください"
            />
          </label>

          {error && (
            <p className="dashboard-banner dashboard-error" role="alert">
              {error}
            </p>
          )}

          <div className="task-form-actions">
            <button type="button" className="task-action-btn" onClick={onClose} disabled={saving}>
              キャンセル
            </button>
            <button type="submit" className="task-action-btn task-action-reply" disabled={saving}>
              {saving ? '登録中…' : '登録'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
