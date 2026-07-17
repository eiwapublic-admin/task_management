import { useEffect, useState } from 'react'
import { fetchUsage } from '../lib/tasks'
import { estimateCostUSD, formatUSD, formatJPY } from '../lib/pricing'

function currentMonthJST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' }).slice(0, 7)
}

export default function UsagePanel() {
  const [usage, setUsage] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const month = currentMonthJST()

  useEffect(() => {
    fetchUsage(month)
      .then((row) => setUsage(row))
      .catch((err) => setError(err.message))
      .finally(() => setLoaded(true))
  }, [month])

  const input = usage?.input_tokens || 0
  const output = usage?.output_tokens || 0
  const calls = usage?.calls || 0
  const costUSD = estimateCostUSD(input, output)

  return (
    <section className="usage-panel">
      <h2>今月のAnthropic API 利用状況</h2>
      {error ? (
        <p className="dashboard-error dashboard-banner" role="alert">
          {error}
        </p>
      ) : !loaded ? (
        <p className="dashboard-loading">読み込み中…</p>
      ) : (
        <dl className="usage-fields">
          <div className="usage-item">
            <dt>対象月</dt>
            <dd>{month}</dd>
          </div>
          <div className="usage-item">
            <dt>分類したメール</dt>
            <dd>{calls.toLocaleString('ja-JP')} 件</dd>
          </div>
          <div className="usage-item">
            <dt>入力トークン</dt>
            <dd>{input.toLocaleString('ja-JP')}</dd>
          </div>
          <div className="usage-item">
            <dt>出力トークン</dt>
            <dd>{output.toLocaleString('ja-JP')}</dd>
          </div>
          <div className="usage-item">
            <dt>推定コスト</dt>
            <dd className="usage-cost">
              {formatUSD(costUSD)} <span className="usage-jpy">（{formatJPY(costUSD)}・目安）</span>
            </dd>
          </div>
        </dl>
      )}
      <p className="settings-hint usage-note">
        当システムが計測したトークン数から Claude（claude-haiku-4-5）の料金で試算した目安です。
        実際の請求額は Anthropic の確定値が正となります。
      </p>
    </section>
  )
}
