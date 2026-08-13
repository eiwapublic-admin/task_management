import { useMemo, useState } from 'react'
import KanbanColumn from './KanbanColumn'
import FeatureHeader from './FeatureHeader'
import FilterBar from './FilterBar'
import TaskDetail from './TaskDetail'
import TaskForm from './TaskForm'
import { IconArchive } from './Icons'
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
  onAddToReport,
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
      {/* 機能ヘッダ（左＝絞り込み / 右＝機能ボタン）。機能名「タスク」はアプリヘッダの
          タイトルが示すので title は置かない。列の見出しはこの下に
          さらに重ねて固定表示する（KanbanColumn.jsx の .ui-sticky-head-2）。
          下の余白は .kanban-board の gap が持つので is-flush で二重取りを避ける */}
      <FeatureHeader
        className="is-flush"
        filters={
          <FilterBar
            assignees={assignees}
            selectedAssignee={selectedAssignee}
            onChange={setSelectedAssignee}
          />
        }
        actions={
          <>
            {lastFetchAt && (
              <span className="kanban-lastfetch">最終取得: {formatDateTime(lastFetchAt)}</span>
            )}
            {onOpenArchive && (
              <button type="button" className="btn-plain" onClick={onOpenArchive} title="アーカイブ">
                <IconArchive size={18} />
                <span className="btn-plain-label">アーカイブ</span>
              </button>
            )}
          </>
        }
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
