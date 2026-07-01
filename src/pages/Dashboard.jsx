import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import KanbanBoard from '../components/KanbanBoard'
import { mockTasks } from '../lib/mockTasks'
import { getCurrentUser, logout } from '../lib/auth'
import './Dashboard.css'

const ASSIGNEES = ['担当者A', '担当者B', '担当者C']

export default function Dashboard() {
  const [tasks, setTasks] = useState(mockTasks)
  const navigate = useNavigate()
  const user = getCurrentUser()

  function handleStatusChange(task, status) {
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status } : t)))
  }

  function handleLogout() {
    logout()
    navigate('/login')
  }

  return (
    <div className="dashboard-page">
      <header className="dashboard-header">
        <h1>タスク管理システム</h1>
        <div className="dashboard-header-right">
          {user && <span className="dashboard-user">{user.display_name} さん</span>}
          <button onClick={() => navigate('/settings')}>設定</button>
          <button onClick={handleLogout}>ログアウト</button>
        </div>
      </header>
      <KanbanBoard tasks={tasks} assignees={ASSIGNEES} onStatusChange={handleStatusChange} />
    </div>
  )
}
