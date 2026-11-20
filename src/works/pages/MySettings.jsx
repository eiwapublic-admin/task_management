// 設定（スタッフ）。いまはアカウントの表示・アプリの更新・ログアウトだけ（項目は今後検討。2026-11-20 依頼元）
import { useNavigate } from 'react-router-dom'
import { getUser, logout } from '../lib/api.js'
import { formatBuildTime } from '../../lib/version.js'
import { reloadApp } from '../../pwa/reloadApp.js'

export default function MySettings() {
  const navigate = useNavigate()
  const user = getUser()
  return (
    <>
      <h1 className="works-title">設定</h1>
      <div className="ui-card">
        <div className="ui-card-title">アカウント</div>
        <div>{user?.staff ? `${user.staff.code} ${user.staff.name}` : user?.display_name}</div>
        <div className="works-muted">ログイン ID: {user?.username}</div>
      </div>
      <div className="ui-card" style={{ marginTop: 12 }}>
        <div className="ui-card-title">アプリ</div>
        <div className="works-row-actions" style={{ marginBottom: 0 }}>
          <span className="works-muted">ver.{formatBuildTime()}</span>
          <button type="button" className="btn-plain" onClick={() => reloadApp({ to: '/me' })}>最新に更新</button>
        </div>
      </div>
      <div className="works-row-actions" style={{ marginTop: 16 }}>
        <button type="button" className="btn-plain" onClick={() => { logout(); navigate('/login') }}>ログアウト</button>
      </div>
      <p className="ui-note">パスワードを忘れたときは、労務担当に「再設定のリンク」の発行を頼んでください。</p>
    </>
  )
}
