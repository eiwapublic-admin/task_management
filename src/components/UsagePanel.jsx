import { useEffect, useMemo, useState } from 'react'
import { fetchUsageMonths } from '../lib/tasks'
import { estimateCostUSD, formatUSD, formatJPY } from '../lib/pricing'

function currentMonthJST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' }).slice(0, 7)
}

// 'YYYY-MM' の前月を返す（JSTの暦月をそのまま扱うため Date は使わない）
function previousMonth(month) {
  const [y, m] = month.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

// 月別の行から表示用の集計値を作る。該当行が無い月は 0 件として扱う。
function summarize(rows) {
  const total = { calls: 0, faxCalls: 0, input: 0, output: 0 }
  for (const r of rows) {
    total.calls += r.calls || 0
    total.faxCalls += r.fax_calls || 0
    total.input += r.input_tokens || 0
    total.output += r.output_tokens || 0
  }
  return {
    ...total,
    // 「分類したメール」はFAXを除いた件数（FAXは添付の読取を伴い単価が異なるため内訳を分ける）
    mailCalls: Math.max(total.calls - total.faxCalls, 0),
    costUSD: estimateCostUSD(total.input, total.output),
  }
}

export default function UsagePanel() {
  const [months, setMonths] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [range, setRange] = useState('current')
  const thisMonth = currentMonthJST()
  const lastMonth = previousMonth(thisMonth)

  useEffect(() => {
    fetchUsageMonths()
      .then((rows) => setMonths(rows))
      .catch((err) => setError(err.message))
      .finally(() => setLoaded(true))
  }, [])

  const views = useMemo(() => {
    const find = (m) => months.filter((r) => r.month === m)
    return {
      current: { label: '今月', caption: thisMonth, data: summarize(find(thisMonth)) },
      last: { label: '先月', caption: lastMonth, data: summarize(find(lastMonth)) },
      total: {
        label: '累計',
        caption: months.length ? `${months[months.length - 1].month} 〜 ${months[0].month}` : '—',
        data: summarize(months),
      },
    }
  }, [months, thisMonth, lastMonth])

  const view = views[range]
  const rows = useMemo(() => months.map((r) => ({ month: r.month, ...summarize([r]) })), [months])
  const grand = views.total.data

  return (
    <section className="usage-panel">
      <h2>Anthropic API 利用状況</h2>
      {error ? (
        <p className="dashboard-error dashboard-banner" role="alert">
          {error}
        </p>
      ) : !loaded ? (
        <p className="dashboard-loading">読み込み中…</p>
      ) : (
        <>
          <div className="usage-range" role="group" aria-label="表示する期間">
            {['current', 'last', 'total'].map((key) => (
              <button
                key={key}
                type="button"
                className={`usage-range-btn${range === key ? ' is-active' : ''}`}
                aria-pressed={range === key}
                onClick={() => setRange(key)}
              >
                {views[key].label}
              </button>
            ))}
          </div>
          <dl className="usage-fields">
            <div className="usage-item">
              <dt>{range === 'total' ? '対象期間' : '対象月'}</dt>
              <dd>{view.caption}</dd>
            </div>
            <div className="usage-item">
              <dt>分類したメール</dt>
              <dd>{view.data.mailCalls.toLocaleString('ja-JP')} 件</dd>
            </div>
            <div className="usage-item">
              <dt>分類したFAX</dt>
              <dd>{view.data.faxCalls.toLocaleString('ja-JP')} 件</dd>
            </div>
            <div className="usage-item">
              <dt>入力トークン</dt>
              <dd>{view.data.input.toLocaleString('ja-JP')}</dd>
            </div>
            <div className="usage-item">
              <dt>出力トークン</dt>
              <dd>{view.data.output.toLocaleString('ja-JP')}</dd>
            </div>
            <div className="usage-item">
              <dt>推定コスト</dt>
              <dd className="usage-cost">
                {formatUSD(view.data.costUSD)}{' '}
                <span className="usage-jpy">（{formatJPY(view.data.costUSD)}・目安）</span>
              </dd>
            </div>
          </dl>

          <h3 className="usage-subtitle">月別の内訳</h3>
          {rows.length === 0 ? (
            <p className="settings-hint">利用実績がまだありません。</p>
          ) : (
            <div className="usage-table-wrap">
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>月</th>
                    <th className="num">メール</th>
                    <th className="num">FAX</th>
                    <th className="num">入力トークン</th>
                    <th className="num">出力トークン</th>
                    <th className="num">推定コスト</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.month} className={r.month === thisMonth ? 'is-current' : undefined}>
                      <th scope="row">
                        {r.month}
                        {r.month === thisMonth ? <span className="usage-badge">今月</span> : null}
                      </th>
                      <td className="num">{r.mailCalls.toLocaleString('ja-JP')}</td>
                      <td className="num">{r.faxCalls.toLocaleString('ja-JP')}</td>
                      <td className="num">{r.input.toLocaleString('ja-JP')}</td>
                      <td className="num">{r.output.toLocaleString('ja-JP')}</td>
                      <td className="num">{formatUSD(r.costUSD)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">累計</th>
                    <td className="num">{grand.mailCalls.toLocaleString('ja-JP')}</td>
                    <td className="num">{grand.faxCalls.toLocaleString('ja-JP')}</td>
                    <td className="num">{grand.input.toLocaleString('ja-JP')}</td>
                    <td className="num">{grand.output.toLocaleString('ja-JP')}</td>
                    <td className="num">
                      {formatUSD(grand.costUSD)}
                      <span className="usage-jpy">（{formatJPY(grand.costUSD)}）</span>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}
      <p className="settings-hint usage-note">
        当システムが計測したトークン数から Claude（claude-haiku-4-5）の料金で試算した目安です。
        実際の請求額は Anthropic の確定値が正となります。
      </p>
    </section>
  )
}
