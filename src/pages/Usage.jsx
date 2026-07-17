import { useNavigate } from 'react-router-dom'
import UsagePanel from '../components/UsagePanel'
import { BILLING_URL } from '../lib/pricing'
import './Dashboard.css'

// 従量課金事項: 今月の Anthropic API 利用状況と、支払い設定への導線をまとめた画面。
// 以前は設定画面の下部に置いていたが、独立した画面へ切り出した。
export default function Usage() {
  const navigate = useNavigate()
  return (
    <div className="dashboard-page">
      <header className="dashboard-header">
        <div className="dashboard-header-left">
          <h1>従量課金事項</h1>
        </div>
        <div className="dashboard-header-right">
          <button
            className="btn-cancel"
            type="button"
            aria-label="カンバンへ戻る"
            title="カンバンへ戻る"
            onClick={() => navigate('/')}
          >
            ×
          </button>
        </div>
      </header>
      <div className="usage-container">
        <UsagePanel />
        <a
          className="usage-billing-link"
          href={BILLING_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Anthropic API 支払設定
        </a>
      </div>
    </div>
  )
}
