import { useState } from 'react'
import { formatDate, formatDateTime, assigneeColor, assigneeInitial, dueStatus } from '../lib/format'
import { UNASSIGNED } from '../lib/status'

// カードに表示する発信元の名前。先方（顧客＝タスクのオーナー）の宛名 contact を最優先で表示する。
// 自社発信・フォーム経由のタスクは sender_display が自社担当者になるため、contact があればそれを使う。
// contact が無ければ sender_display、それも無ければ From ヘッダーの表示名にフォールバックする。
function senderLabel(task) {
  if (task.contact) return task.contact
  if (task.sender_display) return task.sender_display
  const from = task.sender || ''
  const name = from.replace(/<[^>]*>/g, '').replace(/["']/g, '').trim()
  return name || from.trim() || null
}

export default function TaskCard({ task, onDragStart, onClick }) {
  const [subjectOpen, setSubjectOpen] = useState(false)
  const due = dueStatus(task.due_date)
  const isUnassigned = task.assignee === UNASSIGNED

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
        <span className={`task-card-assignee${isUnassigned ? ' is-unassigned' : ''}`}>
          <span
            className="avatar"
            style={{ background: isUnassigned ? 'var(--due-soon)' : assigneeColor(task.assignee) }}
            aria-hidden="true"
          >
            {isUnassigned ? '!' : assigneeInitial(task.assignee)}
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
