import TaskCard from './TaskCard'

export default function KanbanColumn({ status, tasks, onDragStart, onDrop, onCardClick }) {
  return (
    <div
      className="kanban-column"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => onDrop(e, status)}
    >
      <div className="kanban-column-header">
        <span>{status}</span>
        <span className="kanban-column-count">{tasks.length}</span>
      </div>
      <div className="kanban-column-body">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} onDragStart={onDragStart} onClick={onCardClick} />
        ))}
        {tasks.length === 0 && <div className="kanban-column-empty">タスクなし</div>}
      </div>
    </div>
  )
}
