import { useEffect, useMemo, useState } from 'react'
import { fetchUsageMonths } from '../lib/tasks'
import { fetchStorageUsage } from '../lib/reports'
import { estimateCostUSD, formatUSD, formatJPY, BILLING_URL } from '../lib/pricing'
import { formatBytes } from '../lib/imageResize'

function currentMonthJST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' }).slice(0, 7)
}

// 月別の行から表示用の集計値を作る。該当行が無い月は 0 件として扱う。
function summarize(rows) {
  const total = { calls: 0, faxCalls: 0, parkingCalls: 0, input: 0, output: 0 }
  for (const r of rows) {
    total.calls += r.calls || 0
    total.faxCalls += r.fax_calls || 0
    total.parkingCalls += r.parking_calls || 0
    total.input += r.input_tokens || 0
    total.output += r.output_tokens || 0
  }
  return {
    ...total,
    // 「分類したメール」はFAX・車両画像を除いた件数（単価・読み取り対象が異なるため内訳を分ける）
    mailCalls: Math.max(total.calls - total.faxCalls - total.parkingCalls, 0),
    costUSD: estimateCostUSD(total.input, total.output),
  }
}

// 従量課金事項: 月別の内訳表に全ての情報を出すので、以前あった「今月/先月/累計」の
// 期間切替・詳細表示は廃止した（2026-08-05）。一覧表だけで完結させる。
export default function UsagePanel() {
  const [months, setMonths] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  // 日報の写真によるストレージ使用量（2026-08-04）。無料枠1GBに対する余裕を常に見えるようにする
  const [storage, setStorage] = useState(null)
  const thisMonth = currentMonthJST()

  useEffect(() => {
    fetchUsageMonths()
      .then((rows) => setMonths(rows))
      .catch((err) => setError(err.message))
      .finally(() => setLoaded(true))
    // 取得に失敗しても API 利用状況の表示は妨げない
    fetchStorageUsage()
      .then(setStorage)
      .catch(() => setStorage(null))
  }, [])

  const rows = useMemo(() => months.map((r) => ({ month: r.month, ...summarize([r]) })), [months])
  const grand = useMemo(() => summarize(months), [months])

  return (
    <>
      <section className="usage-panel">
        <div className="usage-panel-title">
          <h2>Anthropic API 利用状況</h2>
          <a className="usage-billing-link" href={BILLING_URL} target="_blank" rel="noopener noreferrer">
            Anthropic API 支払設定
          </a>
        </div>
        {error ? (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        ) : !loaded ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : rows.length === 0 ? (
          <p className="settings-hint">利用実績がまだありません。</p>
        ) : (
          <div className="usage-table-wrap">
            <table className="usage-table">
              <thead>
                <tr>
                  <th>月</th>
                  <th className="num">メール</th>
                  <th className="num">FAX</th>
                  <th className="num">車両画像</th>
                  <th className="num">入力トークン</th>
                  <th className="num">出力トークン</th>
                  <th className="num">推定コスト</th>
                  <th className="num">円換算（概算）</th>
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
                    <td className="num">{r.parkingCalls.toLocaleString('ja-JP')}</td>
                    <td className="num">{r.input.toLocaleString('ja-JP')}</td>
                    <td className="num">{r.output.toLocaleString('ja-JP')}</td>
                    <td className="num">{formatUSD(r.costUSD)}</td>
                    <td className="num">{formatJPY(r.costUSD)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">累計</th>
                  <td className="num">{grand.mailCalls.toLocaleString('ja-JP')}</td>
                  <td className="num">{grand.faxCalls.toLocaleString('ja-JP')}</td>
                  <td className="num">{grand.parkingCalls.toLocaleString('ja-JP')}</td>
                  <td className="num">{grand.input.toLocaleString('ja-JP')}</td>
                  <td className="num">{grand.output.toLocaleString('ja-JP')}</td>
                  <td className="num">{formatUSD(grand.costUSD)}</td>
                  <td className="num">{formatJPY(grand.costUSD)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <p className="settings-hint usage-note">
          当システムが計測したトークン数から Claude（claude-haiku-4-5）の料金で試算した目安です。
          実際の請求額は Anthropic の確定値が正となります。
        </p>
      </section>

      {storage && (
        <section className="usage-panel">
          <div className="usage-panel-title">
            <h2>日報の写真ストレージ</h2>
          </div>
          <dl className="usage-fields">
            <div className="usage-item">
              <dt>保存枚数</dt>
              <dd>{(storage.count || 0).toLocaleString('ja-JP')} 枚</dd>
            </div>
            <div className="usage-item">
              <dt>使用量</dt>
              <dd className="usage-cost">
                {formatBytes(storage.total_bytes || 0)}
                <span className="usage-jpy">
                  {' '}
                  / {formatBytes(storage.quota_bytes || 0)}（
                  {((storage.total_bytes / (storage.quota_bytes || 1)) * 100).toFixed(2)}%）
                </span>
              </dd>
            </div>
          </dl>
          <div className="storage-bar" aria-hidden="true">
            <div
              className="storage-bar-fill"
              style={{
                width: `${Math.min((storage.total_bytes / (storage.quota_bytes || 1)) * 100, 100)}%`,
              }}
            />
          </div>
          <p className="settings-hint">
            Supabase 無料プランの上限は 1GB です。写真は保存時に自動で縮小しており、
            現在のペースなら長期間この枠に収まります。
          </p>
        </section>
      )}
    </>
  )
}
