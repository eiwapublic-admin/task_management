import { useMemo, useState } from 'react'
import KanbanColumn from './KanbanColumn'
import FilterBar from './FilterBar'
import TaskDetail from './TaskDetail'
import { STATUS_LIST } from '../lib/status'
import './KanbanBoard.css'

export default function KanbanBoard({ tasks, assignees, onStatusChange }) {
  const [selectedAssignee, setSelectedAssignee] = useState(null)
  const [selectedTask, setSelectedTask] = useState(null)

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

  return (
    <div className="kanban-board">
      <FilterBar
        assignees={assignees}
        selectedAssignee={selectedAssignee}
        onChange={setSelectedAssignee}
      />
      <div className="kanban-columns">
        {STATUS_LIST.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            tasks={filteredTasks.filter((t) => t.status === status)}
            onDragStart={handleDragStart}
            onDrop={handleDrop}
            onCardClick={setSelectedTask}
          />
        ))}
      </div>
      <TaskDetail
        task={selectedTask}
        onClose={() => setSelectedTask(null)}
        onStatusChange={handleStatusChange}
      />
    </div>
  )
}
