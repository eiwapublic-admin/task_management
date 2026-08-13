import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Login from './pages/Login'
import Portal from './pages/Portal'
import Dashboard from './pages/Dashboard'
import Settings from './pages/Settings'
import Logs from './pages/Logs'
import Archive from './pages/Archive'
import Usage from './pages/Usage'
import ReportList from './pages/ReportList'
import ReportTemplates from './pages/ReportTemplates'
import Inspections from './pages/Inspections'
import ParkingViolations from './pages/ParkingViolations'
import Chlorine from './pages/Chlorine'
import Equipment from './pages/Equipment'
import EquipmentItemHistory from './pages/EquipmentItemHistory'
import EquipmentItems from './pages/EquipmentItems'
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
        {/* ダッシュボード 兼 ポータル（2026-08-12）。各機能への入口。
            アプリ起動時の既定表示はカンバン（/）のままにしてあり、この画面へは
            ヘッダーのロゴ（またはハンバーガーメニュー）から入る。
            owner（小泉産業様）も自分が見られる機能のカードだけを見られる */}
        <Route
          path="/portal"
          element={
            <RequireAuth>
              <Portal />
            </RequireAuth>
          }
        />
        {/* 起動時の既定表示。カンバン以外はまだ正式リリースではないため、
            ルート（/）はダッシュボードではなくカンバンのままにしている */}
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
          path="/reports/parking"
          element={
            <RequireAuth>
              <ParkingViolations />
            </RequireAuth>
          }
        />
        {/* 残留塩素等検査（2026-08-10）。オーナー（小泉産業様）は提出物の元データを
            閲覧・PDF出力できるようにするため RequireAuth（書き込みはサーバー側で拒否） */}
        <Route
          path="/reports/chlorine"
          element={
            <RequireAuth>
              <Chlorine />
            </RequireAuth>
          }
        />
        {/* 備品管理（Phase 1。2026-08-12〜）。owner も閲覧できるため RequireAuth
            （書き込みはサーバー側で拒否。docs/equipment-plan.md 9章） */}
        <Route
          path="/equipment"
          element={
            <RequireAuth>
              <Equipment />
            </RequireAuth>
          }
        />
        <Route
          path="/equipment/items"
          element={
            <RequireAuth>
              <EquipmentItems />
            </RequireAuth>
          }
        />
        <Route
          path="/equipment/items/:itemNo"
          element={
            <RequireAuth>
              <EquipmentItemHistory />
            </RequireAuth>
          }
        />
        {/* 日報詳細は一覧の上のモーダルとして出す（2026-08-07）。URL（/reports/:date）は
            そのまま残すことで、他画面（違反車両一覧・タスク側の「本日の日報」など）からの
            リンクとブラウザの戻るボタンが従来どおり使える。描画するのは一覧側で、
            :date が付いていればその日のモーダルを重ねる（ReportList.jsx） */}
        <Route
          path="/reports/:date"
          element={
            <RequireAuth>
              <ReportList />
            </RequireAuth>
          }
        />
      </Routes>
      </BrowserRouter>
    </>
  )
}

export default App
