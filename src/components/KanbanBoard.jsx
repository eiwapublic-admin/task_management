import { useMemo, useState } from 'react'
import KanbanColumn from './KanbanColumn'
import FeatureHeader from './FeatureHeader'
import FilterBar from './FilterBar'
import TaskDetail from './TaskDetail'
import TaskForm from './TaskForm'
import { IconArchive, IconSearch } from './Icons'
import { STATUS_LIST } from '../lib/status'
import './KanbanBoard.css'

// タスクID「T-123」/「t-123」/「123」のいずれでも task_no の完全一致として拾えるようにする
// （アーカイブ画面のフリーワード検索 `worker/index.js` の taskNo 抽出と同じ正規表現）
const TASK_NO_PATTERN = /^\s*[tT]?-?(\d+)\s*$/

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
  // フリーワードでの表示タスク絞り込み（2026-08-14）。カンバンは既にタスク全件を
  // 読み込んでいるため（担当者フィルタと同じ理由）、サーバーへ問い合わせずクライアント側で
  // 絞り込む。対象フィールド・タスクIDの拾い方はアーカイブ画面のフリーワード検索と揃えている
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  function handleToggleSearch() {
    if (searchOpen) {
      setSearchOpen(false)
      setSearchQuery('')
    } else {
      setSearchOpen(true)
    }
  }

  const filteredTasks = useMemo(() => {
    let list = selectedAssignee ? tasks.filter((t) => t.assignee === selectedAssignee) : tasks
    const q = searchQuery.trim().toLowerCase()
    if (q) {
      const taskNo = TASK_NO_PATTERN.exec(q)?.[1]
      list = list.filter((t) => {
        if (taskNo && String(t.task_no) === taskNo) return true
        return [t.title, t.subject, t.body_preview, t.sender, t.sender_display, t.contact, t.remarks]
          .filter(Boolean)
          .some((s) => s.toLowerCase().includes(q))
      })
    }
    return list
  }, [tasks, selectedAssignee, searchQuery])

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
      {/* 機能ヘッダ（左＝絞り込み・検索・アーカイブ / 右＝無し）。機能名「タスク」はアプリヘッダの
          タイトルが示すので title は置かない。最終取得時刻はアプリヘッダのハンバーガー
          メニュー横へ移設した（2026-08-13。AppHeader.jsx参照）。検索・アーカイブは
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
            {/* 検索・アーカイブをまとめて行の右端に寄せる（担当者チップの数によらず
                この2つは常に隣接させたいため、個々のボタンではなくラップ側に
                margin-left: auto を持たせている。2026-08-14） */}
            <span className="kanban-header-trailing">
              <button
                type="button"
                className={`icon-btn-search${searchOpen ? ' is-active' : ''}`}
                onClick={handleToggleSearch}
                aria-label="タスクをキーワードで絞り込む"
                aria-pressed={searchOpen}
                title="タスクをキーワードで絞り込む"
              >
                <IconSearch size={20} />
              </button>
              {onOpenArchive && (
                <button
                  type="button"
                  className="icon-btn-archive"
                  onClick={onOpenArchive}
                  aria-label="アーカイブ"
                  title="アーカイブ"
                >
                  <IconArchive size={20} />
                  {/* PC幅だけ文字ラベルも出す（2026-08-14。狭幅はアイコンのみのまま） */}
                  <span className="icon-btn-archive-label">アーカイブ</span>
                </button>
              )}
            </span>
          </>
        }
      >
        {searchOpen && (
          <div className="reports-search-bar">
            <IconSearch size={18} />
            <input
              type="search"
              className="reports-search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="タイトル・送信元・タスクID等で絞り込み"
              aria-label="タスクをキーワードで絞り込む"
              autoFocus
            />
            {searchQuery && (
              <button
                type="button"
                className="reports-search-clear"
                onClick={() => setSearchQuery('')}
                aria-label="検索文字をクリア"
              >
                ×
              </button>
            )}
          </div>
        )}
      </FeatureHeader>
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
