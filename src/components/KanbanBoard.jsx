import { useMemo, useState } from 'react'
import KanbanColumn from './KanbanColumn'
import FilterBar from './FilterBar'
import TaskDetail from './TaskDetail'
import TaskForm from './TaskForm'
import { STATUS_LIST } from '../lib/status'
import { formatDateTime } from '../lib/format'
import './KanbanBoard.css'

export default function KanbanBoard({
  tasks,
  assignees,
  onStatusChange,
  onCreateTask,
  onUpdateTask,
  onOpenArchive,
  onSpamTask,
  lastFetchAt,
  sharedGmail,
}) {
  const [selectedAssignee, setSelectedAssignee] = useState(null)
  const [selectedTask, setSelectedTask] = useState(null)
  const [showForm, setShowForm] = useState(false)

  const filteredTasks = useMemo(() => {
    if (!selectedAssignee) return tasks
    return tasks.filter((t) => t.assignee === selectedAssignee)
  }, [tasks, selectedAssignee])

  function handleDragStart(e, task) {
    e.dataTransfer.setData('text/plain', task.id)
  }

  function handleDrop(e, status) {
    const taskId = e.dataTransfer.getData('text/plain')
    const task = tasks.find((t) => t.id === taskId)
    if (task && task.status !== status) {
      onStatusChange(task, status)
    }
  }

  function handleStatusChange(task, status) {
    onStatusChange(task, status)
    setSelectedTask((prev) => (prev && prev.id === task.id ? { ...prev, status } : prev))
  }

  // 詳細画面での編集保存。保存後は最新のタスク内容でモーダル表示も更新する。
  async function handleUpdateTask(id, values) {
    const updated = await onUpdateTask(id, values)
    if (updated) {
      setSelectedTask((prev) => (prev && prev.id === id ? { ...prev, ...updated } : prev))
    }
  }

  return (
    <div className="kanban-board">
      <div className="kanban-toolbar">
        <FilterBar
          assignees={assignees}
          selectedAssignee={selectedAssignee}
          onChange={setSelectedAssignee}
        />
        <div className="kanban-toolbar-right">
          {lastFetchAt && (
            <span className="kanban-lastfetch">最終取得: {formatDateTime(lastFetchAt)}</span>
          )}
          {onOpenArchive && (
            <button type="button" className="kanban-archive-btn" onClick={onOpenArchive}>
              アーカイブ
            </button>
          )}
        </div>
      </div>
      <div className="kanban-columns">
        {STATUS_LIST.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            tasks={filteredTasks.filter((t) => t.status === status)}
            onDragStart={handleDragStart}
            onDrop={handleDrop}
            onCardClick={setSelectedTask}
            onAdd={status === '未処理' && onCreateTask ? () => setShowForm(true) : undefined}
            onSpam={onSpamTask}
          />
        ))}
      </div>
      <TaskDetail
        task={selectedTask}
        onClose={() => setSelectedTask(null)}
        onStatusChange={handleStatusChange}
        sharedGmail={sharedGmail}
        assignees={assignees}
        onUpdateTask={onUpdateTask ? handleUpdateTask : undefined}
      />
      {showForm && (
        <TaskForm
          assignees={assignees}
          onClose={() => setShowForm(false)}
          onCreate={onCreateTask}
        />
      )}
    </div>
  )
}
