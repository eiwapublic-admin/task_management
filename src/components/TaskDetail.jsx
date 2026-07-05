import { useEffect, useRef } from 'react'
import { STATUS_LIST } from '../lib/status'
import { formatDate, formatDateTime } from '../lib/format'

export default function TaskDetail({ task, onClose, onStatusChange }) {
  const modalRef = useRef(null)
  const previouslyFocused = useRef(null)

  useEffect(() => {
    if (!task) return

    previouslyFocused.current = document.activeElement
    // 背景のスクロールを止める
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    // 開いたらモーダル内にフォーカスを移す
    modalRef.current?.querySelector('.task-detail-close')?.focus()

    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      // 簡易フォーカストラップ: モーダル内の操作可能要素だけを循環させる
      const focusables = modalRef.current?.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      if (!focusables || focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = prevOverflow
      // 閉じたら元の要素へフォーカスを戻す
      previouslyFocused.current?.focus?.()
    }
  }, [task, onClose])

  if (!task) return null

  return (
    <div className="task-detail-overlay" onClick={onClose}>
      <div
        className="task-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-detail-title"
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="task-detail-header">
          <h2 id="task-detail-title">{task.title}</h2>
          <button className="task-detail-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>
        <dl className="task-detail-fields">
          <dt>担当者</dt>
          <dd>{task.assignee}</dd>
          <dt>ステータス</dt>
          <dd>{task.status}</dd>
          <dt>期限</dt>
          <dd>{formatDate(task.due_date) ?? '未設定'}</dd>
          <dt>受信日時</dt>
          <dd>{formatDateTime(task.received_at) ?? '不明'}</dd>
          <dt>送信者</dt>
          <dd>{task.sender}</dd>
          <dt>件名</dt>
          <dd>{task.subject}</dd>
          <dt>本文プレビュー</dt>
          <dd className="task-detail-body">{task.body_preview}</dd>
          {task.classification_note && (
            <>
              <dt>AI判定の理由</dt>
              <dd className="task-detail-note">{task.classification_note}</dd>
            </>
          )}
        </dl>

        <div className="task-detail-status" role="group" aria-label="ステータスを変更">
          {STATUS_LIST.map((status) => (
            <button
              key={status}
              className={status === task.status ? 'status-btn active' : 'status-btn'}
              aria-pressed={status === task.status}
              onClick={() => onStatusChange(task, status)}
            >
              {status}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
