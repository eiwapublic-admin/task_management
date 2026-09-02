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
import EquipmentTenants from './pages/EquipmentTenants'
import Bilmen from './pages/Bilmen'
import BilmenMasters from './pages/BilmenMasters'
import DocumentTemplates from './pages/DocumentTemplates'
import Contacts from './pages/Contacts'
import { isAuthenticated, getCurrentUser, isLimitedRole } from './lib/auth'
import { ReloadPrompt } from './pwa/ReloadPrompt'

function RequireAuth({ children }) {
  return isAuthenticated() ? children : <Navigate to="/login" replace />
}

// タスク管理セクション用のガード（2026-08-04）。
// owner（小泉産業様）・備品出庫限定ロール（2026-08-25追加）は日報・備品等の閲覧＋
// 備品出庫の登録・修正までしかできないので、タスク管理の各画面へ来たら日報へ送る。
// ※これは画面上の誘導であり、権限の正はサーバー側（Worker の verifyRequestAuth）にある。
function RequireStaff({ children }) {
  if (!isAuthenticated()) return <Navigate to="/login" replace />
  if (isLimitedRole(getCurrentUser())) return <Navigate to="/reports" replace />
  return children
}

// モバイル幅の判定。他画面（ReportList.jsxのWIDE_SCREEN_QUERY等）と同じ768pxを閾値にする
const MOBILE_QUERY = '(max-width: 768px)'

// アプリ起動時、モバイル幅だけはダッシュボード（ポータル）を既定表示にする（2026-09-02）。
// 起動直後の最初の「/」だけをポータルへ振り替えたい（ヘッダー・ハンバーガーの「タスク」
// リンクで明示的に「/」へ来たときはカンバンをそのまま見せる必要がある）ため、
// モジュールスコープのフラグで「まだ振り替えていない最初の1回」だけに限定する
// （コンポーネントのrefだとルートの出入りで作り直されてしまい使えない）
let mobileLaunchRedirected = false

function DefaultRoute() {
  const isMobile = typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches
  if (!mobileLaunchRedirected && isMobile) {
    mobileLaunchRedirected = true
    return <Navigate to="/portal" replace />
  }
  return <Dashboard />
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
        {/* 起動時の既定表示。PC/iPad幅はカンバン（従来どおり）、モバイル幅だけは
            ポータルを既定にする（2026-09-02。DefaultRoute参照）。ヘッダー等から
            明示的に「/」（タスク）を選んだ場合はモバイルでもカンバンをそのまま見せる */}
        <Route
          path="/"
          element={
            <RequireStaff>
              <DefaultRoute />
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
        {/* テナントマスタ（参照専用。2026-08-26）。docs/equipment-plan.md 2-6・7-1参照 */}
        <Route
          path="/equipment/tenants"
          element={
            <RequireAuth>
              <EquipmentTenants />
            </RequireAuth>
          }
        />
        {/* ビルメンテナンス管理（Phase 1。2026-09-02〜）。owner（小泉産業様）は閲覧のみ
            のため RequireAuth（書き込み・カレンダー反映・メール送信はサーバー側で拒否。
            docs/bilmen-plan.md 10章）。メール設定（/bilmen/mail）は Phase 4 で追加する */}
        <Route
          path="/bilmen"
          element={
            <RequireAuth>
              <Bilmen />
            </RequireAuth>
          }
        />
        <Route
          path="/bilmen/masters"
          element={
            <RequireAuth>
              <BilmenMasters />
            </RequireAuth>
          }
        />
        {/* 雛形ファイル（業務で使う資料テンプレート。2026-08-30〜）。owner・備品出庫限定
            ロールも閲覧・ダウンロードはできるため RequireAuth（書き込みはサーバー側で拒否） */}
        <Route
          path="/documents"
          element={
            <RequireAuth>
              <DocumentTemplates />
            </RequireAuth>
          }
        />
        {/* 連絡帳（顧客の連絡先台帳。2026-08-31〜）。タスク・メールの取得実績（顧客の
            メールアドレス等）から自動作成するため、owner（小泉産業様）・備品出庫限定
            ロールには見せない（日報等の閲覧専用画面とは異なり中身が他社の顧客情報のため） */}
        <Route
          path="/contacts"
          element={
            <RequireStaff>
              <Contacts />
            </RequireStaff>
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
