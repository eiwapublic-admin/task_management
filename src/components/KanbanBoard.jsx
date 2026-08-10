import { useMemo, useState } from 'react'
import KanbanColumn from './KanbanColumn'
import FilterBar from './FilterBar'
import TaskDetail from './TaskDetail'
import TaskForm from './TaskForm'
import { STATUS_LIST } from '../lib/status'
import { formatDateTime } from '../lib/format'
import useStickyHeightVar from '../lib/useStickyHeightVar'
import './KanbanBoard.css'

export default function KanbanBoard({
  tasks,
  assignees,
  onStatusChange,
  onCreateTask,
  onUpdateTask,
  onOpenArchive,
  onSpamTask,
  onAddToReport,
  lastFetchAt,
  sharedGmail,
}) {
  const [selectedAssignee, setSelectedAssignee] = useState(null)
  const [selectedTask, setSelectedTask] = useState(null)
  const [showForm, setShowForm] = useState(false)
  // ツールバーをAppHeaderの下に固定表示し、各列のステータス見出しはさらにその下に
  // 重ねて固定表示する（2026-08-11。KanbanColumn.jsx の .ui-sticky-head-2 参照）
  const stickyHeadRef = useStickyHeightVar('--sticky2-h')

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

  // 詳細画面の「スパム」。実行するとサーバー側でアーカイブへ移るため、モーダルを閉じる。
  async function handleSpam(task) {
    setSelectedTask(null)
    await onSpamTask(task)
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
      <div className="kanban-toolbar ui-sticky-head" ref={stickyHeadRef}>
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
        onSpam={onSpamTask ? handleSpam : undefined}
        onAddToReport={onAddToReport}
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
