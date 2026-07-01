import { STATUS_LIST } from '../lib/mockTasks'

export default function TaskDetail({ task, onClose, onStatusChange }) {
  if (!task) return null

  return (
    <div className="task-detail-overlay" onClick={onClose}>
      <div className="task-detail-modal" onClick={(e) => e.stopPropagation()}>
        <button className="task-detail-close" onClick={onClose}>
          ×
        </button>
        <h2>{task.title}</h2>
        <dl className="task-detail-fields">
          <dt>担当者</dt>
          <dd>{task.assignee}</dd>
          <dt>ステータス</dt>
          <dd>{task.status}</dd>
          <dt>期限</dt>
          <dd>{task.due_date ?? '未設定'}</dd>
          <dt>送信者</dt>
          <dd>{task.sender}</dd>
          <dt>件名</dt>
          <dd>{task.subject}</dd>
          <dt>本文プレビュー</dt>
          <dd className="task-detail-body">{task.body_preview}</dd>
        </dl>

        <div className="task-detail-status-buttons">
          {STATUS_LIST.map((status) => (
            <button
              key={status}
              className={status === task.status ? 'status-btn active' : 'status-btn'}
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
