import { currentMonthJST } from '../lib/reports'
import { fiscalMonthsOf, fiscalYearTotals, sameMonthLastYear } from '../lib/yearCompare'
import './YearCompareCharts.css'

// 前年比較グラフ（古紙回収・廃棄物で共通。2026-11-24〜）。
// グラフ描画ライブラリは入れていないため、既存の月別グラフ（Paper.css の .paper-chart）と
// 同じく div + CSS で組む。

// 月別の当年度・前年度（前年同月）を横並びの棒で見せる。
//   months: [{ month: 'YYYY-MM', current, previous }]（4月→3月）
export function MonthCompareChart({ months, fiscalYear, format, unit = 'kg', className = '' }) {
  const max = Math.max(1, ...months.flatMap((m) => [m.current, m.previous]))
  return (
    <div className={`ycc-month ${className}`}>
      <CompareLegend fiscalYear={fiscalYear} />
      <div className="ycc-month-chart" role="img" aria-label={`${fiscalYear}年度と前年度の月別比較`}>
        {months.map((m) => {
          const label = `${Number(m.month.slice(5, 7))}月`
          return (
            <div
              className="ycc-month-col"
              key={m.month}
              title={`${label}: ${fiscalYear}年度 ${format(m.current)}${unit}／${fiscalYear - 1}年度 ${format(m.previous)}${unit}`}
            >
              <span className="ycc-month-value">{m.current > 0 ? format(m.current) : ''}</span>
              <div className="ycc-month-bars">
                <span className="ycc-bar is-previous" style={{ height: `${(m.previous / max) * 100}%` }} />
                <span className="ycc-bar is-current" style={{ height: `${(m.current / max) * 100}%` }} />
              </div>
              <span className="ycc-month-label">{label}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CompareLegend({ fiscalYear }) {
  return (
    <div className="ycc-legend">
      <span className="ycc-legend-item">
        <span className="ycc-swatch is-previous" />
        {fiscalYear - 1}年度
      </span>
      <span className="ycc-legend-item">
        <span className="ycc-swatch is-current" />
        {fiscalYear}年度
      </span>
    </div>
  )
}

// 年度合計を前年度と比べる横棒。年度が終わっていない場合は推計値を点線枠で示し、
// 枠の中に今までの実績を塗りで重ねる。
//   current / previous: { total, estimated: number|null, basisMonths }
export function AnnualCompareChart({ fiscalYear, current, previous, format, unit = 'kg', className = '' }) {
  const curValue = current.estimated ?? current.total
  const prevValue = previous.estimated ?? previous.total
  const max = Math.max(1, curValue, prevValue)
  const ratio = prevValue > 0 && curValue > 0 ? Math.round(((curValue - prevValue) / prevValue) * 100) : null

  return (
    <div className={`ycc-annual ${className}`} role="img" aria-label={`${fiscalYear}年度と前年度の年間合計の比較`}>
      <div className="ycc-annual-head">
        <span className="ycc-annual-title">年間合計 前年度比較</span>
        {ratio != null && (
          <span className={`ycc-annual-ratio${ratio > 0 ? ' is-up' : ratio < 0 ? ' is-down' : ''}`}>
            {current.estimated != null ? '推計 ' : ''}
            {ratio > 0 ? '+' : ''}
            {ratio}%
          </span>
        )}
      </div>
      <AnnualRow label={`${fiscalYear - 1}年度`} totals={previous} max={max} format={format} unit={unit} tone="previous" />
      <AnnualRow label={`${fiscalYear}年度`} totals={current} max={max} format={format} unit={unit} tone="current" />
      {(current.estimated != null || previous.estimated != null) && (
        <p className="ycc-annual-note">
          点線枠＝推計（締まった{current.estimated != null ? `${current.basisMonths}か月の` : '月の'}月平均×12）、塗り＝現時点の実績
        </p>
      )}
    </div>
  )
}

function AnnualRow({ label, totals, max, format, unit, tone }) {
  const isEstimate = totals.estimated != null
  const value = isEstimate ? totals.estimated : totals.total
  return (
    <div className="ycc-annual-row">
      <span className="ycc-annual-label">{label}</span>
      <div className="ycc-annual-track">
        {isEstimate ? (
          <span className={`ycc-annual-bar is-estimate is-${tone}`} style={{ width: `${(value / max) * 100}%` }}>
            <span className="ycc-annual-fill" style={{ width: value > 0 ? `${(totals.total / value) * 100}%` : 0 }} />
          </span>
        ) : (
          <span className={`ycc-annual-bar is-${tone}`} style={{ width: `${(value / max) * 100}%` }} />
        )}
      </div>
      <span className="ycc-annual-value">
        {isEstimate ? (
          <>
            推計 {format(value)}
            {unit}
            <span className="ycc-annual-sub">（実績 {format(totals.total)}{unit}）</span>
          </>
        ) : (
          <>
            {format(value)}
            {unit}
          </>
        )}
      </span>
    </div>
  )
}

// 年度集計タブの中身（古紙回収・廃棄物で共通。2026-11-24〜）。
// 上に「月別（前年同月と横並び）」と「年間合計の前年度比較」のグラフ、下に月別の表
// （合計・前年同月・前年比）。monthTotals / prevMonthTotals は 'YYYY-MM' -> kg の Map
export function YearSummaryPanel({ fiscalYear, monthTotals, prevMonthTotals, format, totalFormat }) {
  const months = fiscalMonthsOf(fiscalYear)
  const currentMonth = currentMonthJST()
  const chartMonths = months.map((m) => ({
    month: m,
    current: monthTotals.get(m) || 0,
    previous: prevMonthTotals.get(sameMonthLastYear(m)) || 0,
  }))
  const current = fiscalYearTotals(fiscalYear, monthTotals, currentMonth)
  const previous = fiscalYearTotals(fiscalYear - 1, prevMonthTotals, currentMonth)

  return (
    <>
      <div className="ycc-panel">
        <MonthCompareChart months={chartMonths} fiscalYear={fiscalYear} format={format} />
        <AnnualCompareChart fiscalYear={fiscalYear} current={current} previous={previous} format={totalFormat} />
      </div>
      <div className="ui-table-wrap">
        <table className="ui-table ycc-table">
          <thead>
            <tr>
              <th>月</th>
              <th className="is-numeric">合計</th>
              <th className="is-numeric">前年同月</th>
              <th className="is-numeric">前年比</th>
            </tr>
          </thead>
          <tbody>
            {chartMonths.map((m) => (
              <tr key={m.month}>
                <td>{Number(m.month.slice(5, 7))}月</td>
                <td className="is-numeric ycc-table-strong">{m.current > 0 ? format(m.current) : ''}</td>
                <td className="is-numeric ycc-table-muted">{m.previous > 0 ? format(m.previous) : ''}</td>
                <td className="is-numeric ycc-table-muted">{formatRatio(m.current, m.previous)}</td>
              </tr>
            ))}
            <tr className="ycc-table-total">
              <td>合計</td>
              <td className="is-numeric">{totalFormat(current.total)}</td>
              <td className="is-numeric">{totalFormat(previous.total)}</td>
              {/* 年度途中は実績どうしを比べると低く出るため、グラフと同じく推計値で比べる */}
              <td className="is-numeric">
                {current.estimated != null
                  ? formatRatio(current.estimated, previous.estimated ?? previous.total) &&
                    `推計 ${formatRatio(current.estimated, previous.estimated ?? previous.total)}`
                  : formatRatio(current.total, previous.total)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  )
}

function formatRatio(current, previous) {
  if (!(current > 0) || !(previous > 0)) return ''
  const ratio = Math.round(((current - previous) / previous) * 100)
  return `${ratio > 0 ? '+' : ''}${ratio}%`
}

// 過去推移タブの中身（2026-11-24〜）。記録のある最初の年度から今年度までの年度合計を
// 縦棒で並べる。年度が終わっていない最新年度は推計値を点線枠で示し、枠の中に実績を塗る。
// 記録が12か月そろっていない過去の年度（記録を始めた年度など）は、棒の下に「nか月分」と出す。
//   monthTotals: 'YYYY-MM' -> kg の Map（全期間）
export function HistoryPanel({ monthTotals, totalFormat, unit = 'kg' }) {
  const currentMonth = currentMonthJST()
  const nowFy = fiscalYearOfMonth(currentMonth)
  const monthsWithData = [...monthTotals].filter(([, v]) => v > 0).map(([m]) => m).sort()
  if (monthsWithData.length === 0) return <p className="dashboard-empty">記録がありません。</p>

  const firstFy = fiscalYearOfMonth(monthsWithData[0])
  const years = []
  for (let fy = firstFy; fy <= nowFy; fy++) {
    const totals = fiscalYearTotals(fy, monthTotals, currentMonth)
    const recorded = fiscalMonthsOf(fy).filter((m) => (monthTotals.get(m) || 0) > 0).length
    years.push({ fy, ...totals, recorded, value: totals.estimated ?? totals.total })
  }
  const max = Math.max(1, ...years.map((y) => y.value))
  const hasEstimate = years.some((y) => y.estimated != null)

  return (
    <>
      <div className="ycc-panel is-history">
        <div className="ycc-history-chart" role="img" aria-label="年度ごとの合計の推移">
          {years.map((y) => {
            const isEstimate = y.estimated != null
            const partial = !isEstimate && y.recorded > 0 && y.recorded < 12
            return (
              <div
                className="ycc-history-col"
                key={y.fy}
                title={`${y.fy}年度: ${isEstimate ? `推計 ${totalFormat(y.value)}${unit}（実績 ${totalFormat(y.total)}${unit}）` : `${totalFormat(y.total)}${unit}`}`}
              >
                <span className={`ycc-history-value${isEstimate ? ' is-estimate' : ''}`}>
                  {y.value > 0 ? `${isEstimate ? '推計 ' : ''}${totalFormat(y.value)}` : ''}
                </span>
                <div className="ycc-history-bar-area">
                  {isEstimate ? (
                    <span className="ycc-history-bar is-estimate" style={{ height: `${(y.value / max) * 100}%` }}>
                      <span
                        className="ycc-history-fill"
                        style={{ height: y.value > 0 ? `${(y.total / y.value) * 100}%` : 0 }}
                      />
                    </span>
                  ) : (
                    <span
                      className={`ycc-history-bar${partial ? ' is-partial' : ''}`}
                      style={{ height: `${(y.value / max) * 100}%` }}
                    />
                  )}
                </div>
                <span className="ycc-history-label">
                  <span className="ycc-only-wide">{y.fy}年度</span>
                  <span className="ycc-only-narrow">{String(y.fy).slice(2)}年度</span>
                </span>
                <span className="ycc-history-sub">{partial ? `${y.recorded}か月分` : ''}</span>
              </div>
            )
          })}
        </div>
        <p className="ycc-annual-note">
          {hasEstimate ? '点線枠＝推計（締まった月の月平均×12）、塗り＝現時点の実績。' : ''}
          薄い棒は12か月分の記録がそろっていない年度です。
        </p>
      </div>
      <div className="ui-table-wrap">
        <table className="ui-table ycc-table">
          <thead>
            <tr>
              <th>年度</th>
              <th className="is-numeric">合計</th>
              <th className="is-numeric">推計</th>
              <th className="is-numeric">前年度比</th>
              <th className="is-numeric">記録のある月</th>
            </tr>
          </thead>
          <tbody>
            {[...years].reverse().map((y) => {
              // 12か月そろっていない年度（記録を始めた年度など）との比較は意味がないため出さない
              const prev = years.find((p) => p.fy === y.fy - 1 && (p.recorded === 12 || p.estimated != null))
              return (
                <tr key={y.fy}>
                  <td>{y.fy}年度</td>
                  <td className="is-numeric ycc-table-strong">{totalFormat(y.total)}</td>
                  <td className="is-numeric ycc-table-muted">{y.estimated != null ? totalFormat(y.estimated) : ''}</td>
                  <td className="is-numeric ycc-table-muted">{prev ? formatRatio(y.value, prev.value) : ''}</td>
                  <td className="is-numeric ycc-table-muted">{y.recorded}か月</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

function fiscalYearOfMonth(month) {
  const [y, m] = month.split('-').map(Number)
  return m >= 4 ? y : y - 1
}
