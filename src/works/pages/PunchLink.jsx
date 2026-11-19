// /p … 掲示物の QR を iPhone 等の標準カメラで読んだときに開く画面。
// ログイン済みならそのまま打刻する。iPhone では「ホーム画面のアプリ」と「Safari」でログインが別なので、
// ログインしていなければアプリ内の読み取りを案内する（docs/eworks-plan.md 6-2）
import { useMemo } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import PunchFlow from '../components/PunchFlow.jsx'
import { isLoggedIn } from '../lib/api.js'
import { parsePunchQr } from '../lib/qr.js'

export default function PunchLink() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const qr = useMemo(() => parsePunchQr(`${window.location.origin}/p?${params}`), [params])
  if (!qr) {
    return (
      <div className="works-auth"><div className="works-auth-card"><p>QR コードが正しくありません。</p><Link to="/">eWorks を開く</Link></div></div>
    )
  }
  if (!isLoggedIn()) {
    return (
      <div className="works-auth">
       <div className="works-auth-card">
        <h1 className="works-title">eWorks</h1>
        <p>このブラウザではログインしていません。</p>
        <p>ホーム画面の <strong>eWorks</strong> アプリを開き、ホームの「出勤を記録」「退勤を記録」から QR を読んでください。</p>
        <p className="works-muted">アプリを入れていない場合は <Link to="/login">ログイン</Link> してから、もう一度 QR を読んでください。</p>
       </div>
      </div>
    )
  }
  return <PunchFlow preset={qr} onClose={() => navigate('/', { replace: true })} />
}
