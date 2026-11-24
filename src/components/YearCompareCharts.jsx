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
