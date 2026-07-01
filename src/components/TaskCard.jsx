import { useState } from 'react'

function formatDate(value) {
  if (!value) return null
  return new Date(value).toLocaleDateString('ja-JP')
}

function formatDateTime(value) {
  if (!value) return null
  return new Date(value).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function TaskCard({ task, onDragStart, onClick }) {
  const [subjectOpen, setSubjectOpen] = useState(false)

  return (
    <div
      className="task-card"
      draggable
      onDragStart={(e) => onDragStart(e, task)}
      onClick={() => onClick(task)}
    >
      <div className="task-card-title">{task.title}</div>
      <div className="task-card-meta">
        <span className="task-card-assignee">{task.assignee}</span>
        {task.due_date && <span className="task-card-due">期限: {formatDate(task.due_date)}</span>}
      </div>
      <div className="task-card-received">受信: {formatDateTime(task.received_at)}</div>

      <button
        type="button"
        className="task-card-subject-toggle"
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
