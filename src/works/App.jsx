// eWorks（勤怠管理）の画面の入口。権限の正はサーバー側（worker/lib/works/auth.js）で、
// ここでは管理者向けのメニューを出すかどうかだけを決める。
import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom'
import { api, getUser, isLoggedIn, logout, setUser } from './lib/api.js'
import Login from './pages/Login.jsx'
import Invite from './pages/Invite.jsx'
import Home from './pages/Home.jsx'
import Staff from './pages/Staff.jsx'
import Patterns from './pages/Patterns.jsx'
import Sites from './pages/Sites.jsx'
import Settings from './pages/Settings.jsx'

const ADMIN_MENU = [
  { to: '/staff', label: 'スタッフ' },
  { to: '/patterns', label: '出退勤パターン' },
  { to: '/sites', label: '現場' },
  { to: '/settings', label: '設定' },
]

function Shell({ children }) {
  const navigate = useNavigate()
  const [user, setU] = useState(getUser())
  useEffect(() => {
    // 権限が変わっていることがあるので、開くたびにサーバーから取り直す
    api('/api/works/me')
      .then(({ user }) => {
        setUser(user)
        setU(user)
      })
      .catch(() => {})
  }, [])
  const menu = [{ to: '/', label: 'ホーム', end: true }, ...(user?.works_admin ? ADMIN_MENU : [])]
  const signOut = () => {
    logout()
    navigate('/login')
  }
  return (
    <div className="works-shell">
      <aside className="works-side">
        <div className="works-brand">
          <img src="/icon.svg" alt="" />
          eWorks
        </div>
        <nav className="works-nav">
          {menu.map((m) => (
            <NavLink key={m.to} to={m.to} end={m.end}>
              {m.label}
            </NavLink>
          ))}
        </nav>
        <div className="works-side-foot">
          <div>{user?.display_name}</div>
          <button type="button" className="btn-plain" onClick={signOut} style={{ marginTop: 8 }}>
            ログアウト
          </button>
        </div>
      </aside>
      <main className="works-main">
        <div className="works-content">{typeof children === 'function' ? children(user) : children}</div>
      </main>
      <nav className="works-tabbar">
        {menu.map((m) => (
          <NavLink key={m.to} to={m.to} end={m.end}>
            {m.label}
          </NavLink>
        ))}
        <a href="/login" onClick={(e) => { e.preventDefault(); signOut() }}>ログアウト</a>
      </nav>
    </div>
  )
}

function Private({ children, admin = false }) {
  if (!isLoggedIn()) return <Navigate to="/login" replace />
  if (admin && !getUser()?.works_admin) return <Navigate to="/" replace />
  return <Shell>{children}</Shell>
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/invite" element={<Invite />} />
        <Route path="/" element={<Private>{(user) => <Home user={user} />}</Private>} />
        <Route path="/staff" element={<Private admin><Staff /></Private>} />
        <Route path="/patterns" element={<Private admin><Patterns /></Private>} />
        <Route path="/sites" element={<Private admin><Sites /></Private>} />
        <Route path="/settings" element={<Private admin><Settings /></Private>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
