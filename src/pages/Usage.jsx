import AppHeader from '../components/AppHeader'
import UsagePanel from '../components/UsagePanel'
import { BILLING_URL } from '../lib/pricing'
import './Dashboard.css'

// 従量課金事項: 今月の Anthropic API 利用状況と、支払い設定への導線をまとめた画面。
// 以前は設定画面の下部に置いていたが、独立した画面へ切り出した。
export default function Usage() {
  return (
    <div className="dashboard-page">
      <AppHeader />
      <div className="usage-container">
        <h2 className="page-title">従量課金事項</h2>
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
