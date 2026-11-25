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

// 管理者の PC のメニュー（2026-11-24 依頼元の要望）。「ホーム」「休暇」は廃止し、グループに分ける。
//   勤務管理: 勤務一覧・スタッフ別・要確認・有給休暇の管理 ／ マスター: スタッフ・出勤パターン・現場 ／ 設定
// 管理者自身の勤務は「スタッフ別」で自分を選んで入力し、休暇の申請も「スタッフ別」の日の詳細から行う
const adminGroups = (alertTotal, leaveTotal = 0) => [
  {
    label: '勤務管理',
    items: [
      { to: '/monthly', label: '勤務一覧', icon: 'list', short: '一覧' },
      { to: '/calendar', label: 'スタッフ別', icon: 'calendar' },
      { to: '/alerts', label: '要確認', icon: 'alert', badge: alertTotal },
      { to: '/leave', label: '有給休暇の管理', icon: 'leave', short: '有給', badge: leaveTotal },
    ],
  },
  {
    label: 'マスター',
    items: [
      { to: '/staff', label: 'スタッフ', icon: 'staff' },
      { to: '/patterns', label: '出勤パターン', icon: 'pattern' },
      { to: '/sites', label: '現場', icon: 'site' },
    ],
  },
  { items: [{ to: '/settings', label: '設定', icon: 'settings' }] },
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
  const isAdmin = !!user?.works_admin
  const groups = isAdmin
    ? adminGroups(alertTotal, alertCount?.leave_requests || 0)
    : [
        {
          items: [
            { to: '/', label: 'ホーム', end: true },
            { to: '/calendar', label: 'カレンダー' },
            { to: '/vacation', label: '休暇' },
            { to: '/me', label: '設定' },
          ],
        },
      ]
  const signOut = () => {
    logout()
    navigate('/login')
  }
  // スマホの下部メニュー（アイコン型。2026-11-20 依頼元の要望）
  //   管理者: PC の「勤務管理」の 4 つ（一覧｜スタッフ別｜要確認｜有給）＋その他（マスター・設定・ログアウト）（2026-11-24）
  //   スタッフ: ホーム｜カレンダー｜休暇｜設定
  const tabs = isAdmin
    ? groups[0].items.map((m) => ({ ...m, label: m.short || m.label }))
    : [
        { to: '/', label: 'ホーム', icon: 'home', end: true },
        { to: '/calendar', label: 'カレンダー', icon: 'calendar' },
        { to: '/vacation', label: '休暇', icon: 'vacation' },
        { to: '/me', label: '設定', icon: 'settings' },
      ]
  const more = isAdmin ? groups.slice(1) : null
  return (
    <div className="works-shell">
      <aside className="works-side">
        <div className="works-brand">
          <img src="/icon.svg" alt="" />
          eWorks
        </div>
        <nav className="works-nav">
          {groups.map((g, i) => (
            <div key={i} className="works-nav-group">
              {g.label && <div className="works-nav-label">{g.label}</div>}
              {g.items.map((m) => (
                <NavLink key={m.to} to={m.to} end={m.end} className={g.label ? 'is-sub' : ''}>
                  {m.label}
                  {m.badge > 0 && <span className="works-count">{m.badge}</span>}
                </NavLink>
              ))}
            </div>
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
      <TabBar tabs={tabs} more={more} onSignOut={signOut} />
    </div>
  )
}

function TabBar({ tabs, more, onSignOut }) {
  const [open, setOpen] = useState(false)
  const { pathname } = useLocation()
  useEffect(() => setOpen(false), [pathname])
  const moreItems = (more || []).flatMap((g) => g.items)
  const moreActive = moreItems.some((m) => pathname.startsWith(m.to))
  return (
    <>
      {open && (
        <div className="works-more" onClick={() => setOpen(false)}>
          <div className="works-more-sheet" role="menu" onClick={(e) => e.stopPropagation()}>
            {more.map((g, i) => (
              <div key={i} role="group" aria-label={g.label}>
                {g.label && <div className="works-more-label">{g.label}</div>}
                {g.items.map((m) => (
                  <NavLink key={m.to} to={m.to} role="menuitem">
                    <TabIcon name={m.icon} size={22} />
                    {m.label}
                  </NavLink>
                ))}
              </div>
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
            {m.badge > 0 && <span className="works-count works-tab-count">{m.badge}</span>}
          </NavLink>
        ))}
        {more && (
          <button type="button" className={moreActive || open ? 'active' : ''} aria-expanded={open} onClick={() => setOpen(!open)}>
            <TabIcon name="more" />
            <span>その他</span>
          </button>
        )}
      </nav>
    </>
  )
}

// 「/」はスタッフのホーム。管理者はホームを廃止したので（2026-11-24）、いつも勤務一覧へ
function StartPage() {
  if (isLoggedIn() && getUser()?.works_admin) return <Navigate to="/monthly" replace />
  return <Private>{(user) => <Home user={user} />}</Private>
}

function Private({ children, admin = false, staffOnly = '' }) {
  if (!isLoggedIn()) return <Navigate to="/login" replace />
  if (admin && !getUser()?.works_admin) return <Navigate to="/" replace />
  // 管理者の「休暇」画面は廃止（休暇の申請・残日数は「スタッフ別」へ。2026-11-24）
  if (staffOnly && getUser()?.works_admin) return <Navigate to={staffOnly} replace />
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
        <Route path="/me" element={<Private staffOnly="/settings"><MySettings /></Private>} />
        <Route path="/vacation" element={<Private staffOnly="/calendar"><Vacation /></Private>} />
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
