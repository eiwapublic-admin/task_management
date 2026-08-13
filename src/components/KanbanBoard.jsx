import { useMemo, useState } from 'react'
import KanbanColumn from './KanbanColumn'
import FeatureHeader from './FeatureHeader'
import FilterBar from './FilterBar'
import TaskDetail from './TaskDetail'
import TaskForm from './TaskForm'
import { IconArchive } from './Icons'
import { STATUS_LIST } from '../lib/status'
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
      {/* 機能ヘッダ（左＝絞り込み・アーカイブ / 右＝無し）。機能名「タスク」はアプリヘッダの
          タイトルが示すので title は置かない。最終取得時刻はアプリヘッダのハンバーガー
          メニュー横へ移設した（2026-08-13。AppHeader.jsx参照）。アーカイブは
          actions（狭幅で2行目に分かれる）ではなく filters 側に置き、モバイルでも
          絞り込みと同じ1行目の右端に収まるようにする（margin-left: autoで右寄せ） */}
      <FeatureHeader
        className="is-flush"
        filters={
          <>
            <FilterBar
              assignees={assignees}
              selectedAssignee={selectedAssignee}
              onChange={setSelectedAssignee}
            />
            {onOpenArchive && (
              <button
                type="button"
                className="icon-btn-archive"
                onClick={onOpenArchive}
                aria-label="アーカイブ"
                title="アーカイブ"
              >
                <IconArchive size={20} />
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
