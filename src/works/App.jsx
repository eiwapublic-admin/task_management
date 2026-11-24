// eWorks（勤怠管理）の画面の入口。権限の正はサーバー側（worker/lib/works/auth.js）で、
// ここでは管理者向けのメニューを出すかどうかだけを決める。
import { lazy, Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { api, getUser, isLoggedIn, logout, setUser } from './lib/api.js'
import Login from './pages/Login.jsx'
import Invite from './pages/Invite.jsx'
import Home from './pages/Home.jsx'
import Staff from './pages/Staff.jsx'
import Patterns from './pages/Patterns.jsx'
import Sites from './pages/Sites.jsx'
import Settings from './pages/Settings.jsx'
import Calendar from './pages/Calendar.jsx'
import Monthly from './pages/Monthly.jsx'
import Leave from './pages/Leave.jsx'
import Vacation from './pages/Vacation.jsx'
import MySettings from './pages/MySettings.jsx'
import Alerts from './pages/Alerts.jsx'
import TabIcon from './components/TabIcons.jsx'
import { ReloadPrompt } from '../pwa/ReloadPrompt.jsx'

const PunchLink = lazy(() => import('./pages/PunchLink.jsx'))

const ADMIN_MENU = [
  { to: '/leave', label: '有給休暇の管理' },
  { to: '/staff', label: 'スタッフ' },
  { to: '/patterns', label: '出退勤パターン' },
  { to: '/sites', label: '現場' },
  { to: '/settings', label: '設定' },
]

// 管理者の「要確認」の件数（未確認＋承認待ちの修正申請）。画面を移るたび（1 分に 1 回まで）と、確認したときに取り直す
let countCache = { at: 0, value: null }
function useAlertCount(enabled) {
  const { pathname } = useLocation()
  const [count, setCount] = useState(countCache.value)
  useEffect(() => {
    if (!enabled) return
    const fetchCount = (force) => {
      if (!force && Date.now() - countCache.at < 60e3) return setCount(countCache.value)
      countCache.at = Date.now()
      api('/api/works/alerts/count')
        .then((c) => {
          countCache.value = c
          setCount(c)
        })
        .catch(() => {})
    }
    fetchCount(false)
    const onChange = () => fetchCount(true)
    window.addEventListener('works-alerts-changed', onChange)
    return () => window.removeEventListener('works-alerts-changed', onChange)
  }, [enabled, pathname])
  return count
}

function Shell({ children }) {
  const navigate = useNavigate()
  const [user, setU] = useState(getUser())
  const alertCount = useAlertCount(!!user?.works_admin)
  const alertTotal = alertCount ? alertCount.open + alertCount.requests : 0
  useEffect(() => {
    // 権限が変わっていることがあるので、開くたびにサーバーから取り直す
    api('/api/works/me')
      .then(({ user }) => {
        setUser(user)
        setU(user)
      })
      .catch(() => {})
  }, [])
  const menu = [
    { to: '/', label: 'ホーム', end: true },
    ...(user?.works_admin ? [{ to: '/monthly', label: '勤務表一覧' }, { to: '/alerts', label: '要確認', badge: alertTotal }] : []),
    { to: '/calendar', label: 'カレンダー' },
    { to: '/vacation', label: '休暇' },
    ...(user?.works_admin ? ADMIN_MENU : []),
  ]
  if (!user?.works_admin) menu.push({ to: '/me', label: '設定' })
  const signOut = () => {
    logout()
    navigate('/login')
  }
  // スマホの下部メニュー（アイコン型。2026-11-20 依頼元の要望）
  //   管理者: ホーム｜一覧｜有給｜スタッフ｜その他（要確認・カレンダー・休暇・出退勤パターン・現場・設定・ログアウト）
  //   スタッフ: ホーム｜カレンダー｜休暇｜設定
  const tabs = user?.works_admin
    ? [
        { to: '/', label: 'ホーム', icon: 'home', end: true },
        { to: '/monthly', label: '一覧', icon: 'list' },
        { to: '/leave', label: '有給', icon: 'leave' },
        { to: '/staff', label: 'スタッフ', icon: 'staff' },
      ]
    : [
        { to: '/', label: 'ホーム', icon: 'home', end: true },
        { to: '/calendar', label: 'カレンダー', icon: 'calendar' },
        { to: '/vacation', label: '休暇', icon: 'vacation' },
        { to: '/me', label: '設定', icon: 'settings' },
      ]
  const more = [
    { to: '/alerts', label: '要確認', icon: 'alert', badge: alertTotal },
    { to: '/calendar', label: 'カレンダー', icon: 'calendar' },
    { to: '/vacation', label: '休暇（自分の申請）', icon: 'vacation' },
    { to: '/patterns', label: '出退勤パターン', icon: 'pattern' },
    { to: '/sites', label: '現場', icon: 'site' },
    { to: '/settings', label: '設定', icon: 'settings' },
  ]
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
              {m.badge > 0 && <span className="works-count">{m.badge}</span>}
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
      <TabBar tabs={tabs} more={user?.works_admin ? more : null} onSignOut={signOut} />
    </div>
  )
}

function TabBar({ tabs, more, onSignOut }) {
  const [open, setOpen] = useState(false)
  const { pathname } = useLocation()
  useEffect(() => setOpen(false), [pathname])
  const moreActive = more?.some((m) => pathname.startsWith(m.to))
  const moreBadge = (more || []).reduce((a, m) => a + (m.badge || 0), 0)
  return (
    <>
      {open && (
        <div className="works-more" onClick={() => setOpen(false)}>
          <div className="works-more-sheet" role="menu" onClick={(e) => e.stopPropagation()}>
            {more.map((m) => (
              <NavLink key={m.to} to={m.to} role="menuitem">
                <TabIcon name={m.icon} size={22} />
                {m.label}
                {m.badge > 0 && <span className="works-count">{m.badge}</span>}
              </NavLink>
            ))}
            <button type="button" role="menuitem" onClick={onSignOut}>
              <TabIcon name="logout" size={22} />
              ログアウト
            </button>
          </div>
        </div>
      )}
      <nav className="works-tabbar">
        {tabs.map((m) => (
          <NavLink key={m.to} to={m.to} end={m.end}>
            <TabIcon name={m.icon} />
            <span>{m.label}</span>
          </NavLink>
        ))}
        {more && (
          <button type="button" className={moreActive || open ? 'active' : ''} aria-expanded={open} onClick={() => setOpen(!open)}>
            <TabIcon name="more" />
            <span>その他</span>
            {moreBadge > 0 && <span className="works-count works-tab-count">{moreBadge}</span>}
          </button>
        )}
      </nav>
    </>
  )
}

// アプリを開いたとき（ログイン直後・起動直後）の最初の画面。管理者は勤務表一覧から始める。
// ホームへは 2 回目以降（メニューから選んだとき）は普通に入れるよう、起動時の 1 回だけ振り分ける
let startHandled = false
function StartPage() {
  if (!startHandled) {
    startHandled = true
    if (isLoggedIn() && getUser()?.works_admin) return <Navigate to="/monthly" replace />
  }
  return <Private>{(user) => <Home user={user} />}</Private>
}

function Private({ children, admin = false }) {
  if (!isLoggedIn()) return <Navigate to="/login" replace />
  if (admin && !getUser()?.works_admin) return <Navigate to="/" replace />
  return <Shell>{children}</Shell>
}

export default function App() {
  return (
    <BrowserRouter>
      {/* 新しい版を公開したら画面上部に「更新」バナーを出す（タスク管理と同じ仕組み。sw.js はビルドごとに版が変わる） */}
      {import.meta.env.PROD && <ReloadPrompt accentColor="#6b4fb3" position="top" />}
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/invite" element={<Invite />} />
        <Route path="/p" element={<Suspense fallback={null}><PunchLink /></Suspense>} />
        <Route path="/" element={<StartPage />} />
        <Route path="/calendar" element={<Private><Calendar /></Private>} />
        <Route path="/monthly" element={<Private admin><Monthly /></Private>} />
        <Route path="/alerts" element={<Private admin><Alerts /></Private>} />
        <Route path="/me" element={<Private><MySettings /></Private>} />
        <Route path="/vacation" element={<Private><Vacation /></Private>} />
        <Route path="/leave" element={<Private admin><Leave /></Private>} />
        <Route path="/staff" element={<Private admin><Staff /></Private>} />
        <Route path="/patterns" element={<Private admin><Patterns /></Private>} />
        <Route path="/sites" element={<Private admin><Sites /></Private>} />
        <Route path="/settings" element={<Private admin><Settings /></Private>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
