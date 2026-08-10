import AppHeader from '../components/AppHeader'
import UsagePanel from '../components/UsagePanel'
import './Dashboard.css'

// 従量課金事項: Anthropic API の月別利用状況（内訳表）と、日報の写真ストレージ使用量をまとめた画面。
// 支払い設定への導線は UsagePanel 内の「Anthropic API利用状況」見出し行の右上に置いている（2026-08-05）。
export default function Usage() {
  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-narrow">
        <h2 className="ui-page-title">従量課金事項</h2>
        <UsagePanel />
      </div>
    </div>
  )
}
