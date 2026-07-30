import { useState } from 'react'
import TaskCard from './TaskCard'
import { STATUS_META } from '../lib/status'

export default function KanbanColumn({ status, tasks, onDragStart, onDrop, onCardClick, onAdd, onSpam }) {
  const [isOver, setIsOver] = useState(false)
  const accent = STATUS_META[status]?.color

  function handleDrop(e) {
    setIsOver(false)
    onDrop(e, status)
  }

  return (
    <section
      className={`kanban-column${isOver ? ' is-over' : ''}`}
      style={{ '--column-accent': accent }}
      data-status={status}
      aria-label={`${status}（${tasks.length}件）`}
      onDragOver={(e) => {
        e.preventDefault()
        if (!isOver) setIsOver(true)
      }}
      onDragLeave={(e) => {
        // 子要素間の移動で誤発火しないよう、列の外に出たときだけ解除する
        if (!e.currentTarget.contains(e.relatedTarget)) setIsOver(false)
      }}
      onDrop={handleDrop}
    >
      <div className="kanban-column-header">
        <span className="kanban-column-title">
          <span className="kanban-column-dot" style={{ background: accent }} aria-hidden="true" />
          {status}
        </span>
        <span className="kanban-column-header-right">
          {onAdd && (
            <button
              type="button"
              className="kanban-column-add"
              onClick={onAdd}
              aria-label="タスクを手動で追加"
              title="タスクを手動で追加"
            >
              ＋
            </button>
          )}
          <span className="kanban-column-count">{tasks.length}</span>
        </span>
      </div>
      <div className="kanban-column-body">
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            onDragStart={onDragStart}
            onClick={onCardClick}
            onSpam={onSpam}
          />
        ))}
        {tasks.length === 0 && <div className="kanban-column-empty">ここにドロップ</div>}
      </div>
    </section>
  )
}
