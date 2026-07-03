import { useState } from 'react'
import { formatDate, formatDateTime, assigneeColor, assigneeInitial, dueStatus } from '../lib/format'

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

      {(task.contact || task.sender) && (
        <div className="task-card-contact" title={task.sender || undefined}>
          <span className="task-card-contact-label">発信元</span>
          <span className="task-card-contact-value">{task.contact || task.sender}</span>
        </div>
      )}

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
