import { useState } from 'react'
import { formatDate, formatDateTime, assigneeColor, assigneeInitial, dueStatus } from '../lib/format'

// カードに表示する送信元。Claude が抽出した会社名・氏名（sender_display）を優先し、
// 無い場合は From ヘッダーの表示名（"名前 <mail@...>" の名前部分）にフォールバックする。
function senderLabel(task) {
  if (task.sender_display) return task.sender_display
  const from = task.sender || ''
  const name = from.replace(/<[^>]*>/g, '').replace(/["']/g, '').trim()
  return name || from.trim() || null
}

export default function TaskCard({ task, onDragStart, onClick }) {
  const [subjectOpen, setSubjectOpen] = useState(false)
  const due = dueStatus(task.due_date)

  function handleKeyDown(e) {
    // カード全体をキーボードで開けるようにする（Enter / Space）
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick(task)
    }
  }

  return (
    <div
      className="task-card"
      draggable
      role="button"
      tabIndex={0}
      aria-label={`${task.title} / 担当 ${task.assignee}`}
      onDragStart={(e) => onDragStart(e, task)}
      onClick={() => onClick(task)}
      onKeyDown={handleKeyDown}
    >
      <div className="task-card-title">{task.title}</div>

      {senderLabel(task) && <div className="task-card-sender">{senderLabel(task)}</div>}

      <div className="task-card-meta">
        <span className="task-card-assignee">
          <span className="avatar" style={{ background: assigneeColor(task.assignee) }} aria-hidden="true">
            {assigneeInitial(task.assignee)}
          </span>
          {task.assignee}
        </span>
        {task.due_date && (
          <span className={`task-card-due${due?.level ? ` due-${due.level}` : ''}`}>
            期限: {formatDate(task.due_date)}
          </span>
        )}
      </div>

      {due?.label && <div className={`task-card-due-flag due-${due.level}`}>{due.label}</div>}

      <div className="task-card-received">受信: {formatDateTime(task.received_at)}</div>

      <button
        type="button"
        className="task-card-subject-toggle"
        aria-expanded={subjectOpen}
        onClick={(e) => {
          e.stopPropagation()
          setSubjectOpen((v) => !v)
        }}
      >
        {subjectOpen ? '件名を閉じる ▲' : '件名を表示 ▼'}
      </button>
      {subjectOpen && <div className="task-card-subject">{task.subject}</div>}
    </div>
  )
}
