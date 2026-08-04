import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Settings from './pages/Settings'
import Logs from './pages/Logs'
import Archive from './pages/Archive'
import Usage from './pages/Usage'
import ReportList from './pages/ReportList'
import ReportDetail from './pages/ReportDetail'
import ReportTemplates from './pages/ReportTemplates'
import Inspections from './pages/Inspections'
import { isAuthenticated, getCurrentUser } from './lib/auth'
import { ReloadPrompt } from './pwa/ReloadPrompt'

function RequireAuth({ children }) {
  return isAuthenticated() ? children : <Navigate to="/login" replace />
}

// タスク管理セクション用のガード（2026-08-04）。
// owner（小泉産業様）は日報のみを見られるので、タスク管理の各画面へ来たら日報へ送る。
// ※これは画面上の誘導であり、権限の正はサーバー側（Worker の verifyRequestAuth）にある。
function RequireStaff({ children }) {
  if (!isAuthenticated()) return <Navigate to="/login" replace />
  if (getCurrentUser()?.role === 'owner') return <Navigate to="/reports" replace />
  return children
}

function App() {
  return (
    <>
      {/* 新バージョン検知バナー。開発中(vite dev)は SW を登録せず出さない */}
      {import.meta.env.PROD && <ReloadPrompt accentColor="#33604d" position="top" />}
      <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <RequireStaff>
              <Dashboard />
            </RequireStaff>
          }
        />
        <Route
          path="/logs"
          element={
            <RequireStaff>
              <Logs />
            </RequireStaff>
          }
        />
        <Route
          path="/archive"
          element={
            <RequireStaff>
              <Archive />
            </RequireStaff>
          }
        />
        <Route
          path="/usage"
          element={
            <RequireStaff>
              <Usage />
            </RequireStaff>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireStaff>
              <Settings />
            </RequireStaff>
          }
        />
        {/* 日報（2026-08-04〜）。owner も閲覧できるため RequireAuth のまま */}
        <Route
          path="/reports"
          element={
            <RequireAuth>
              <ReportList />
            </RequireAuth>
          }
        />
        <Route
          path="/reports/templates"
          element={
            <RequireStaff>
              <ReportTemplates />
            </RequireStaff>
          }
        />
        <Route
          path="/reports/inspections"
          element={
            <RequireAuth>
              <Inspections />
            </RequireAuth>
          }
        />
        <Route
          path="/reports/:date"
          element={
            <RequireAuth>
              <ReportDetail />
            </RequireAuth>
          }
        />
      </Routes>
      </BrowserRouter>
    </>
  )
}

export default App
