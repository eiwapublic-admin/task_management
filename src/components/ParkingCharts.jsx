// 違反車両ダッシュボードの小さなグラフ部品（2026-08-25新規）。専用のグラフ描画
// ライブラリは入っていないため、プレーンなSVG/div+CSSで組む（dataviz方針: 折れ線は
// 2px・端点は角丸結合、マーカーは半径4px以上＋地の色の2pxリングで縁取り、基準線は
// 1本だけの控えめな1pxグリッド、直接ラベルで値を示す）。1系列のグラフのため凡例は
// 置かず、カード見出し（呼び出し側）が「何のグラフか」を示す。

// 月別の件数推移（直近12か月・折れ線グラフ。2026-08-25、棒グラフから変更）。
// viewBoxの座標系のまま幅100%・高さautoで拡大縮小させ、線・マーカー・文字を
// 常に同じ比率で保つ（幅と高さを別々に固定すると歪んで見えるため）
const TREND_W = 360
const TREND_H = 140
const TREND_PAD_X = 18
const TREND_PLOT_TOP = 22
const TREND_PLOT_BOTTOM = 104
const TREND_MONTH_Y = 128

export function MonthlyTrendChart({ data }) {
  const max = Math.max(1, ...data.map((d) => d.count))
  const n = data.length
  const step = n > 1 ? (TREND_W - TREND_PAD_X * 2) / (n - 1) : 0
  const points = data.map((d, i) => ({
    ...d,
    x: TREND_PAD_X + i * step,
    y: TREND_PLOT_BOTTOM - (d.count / max) * (TREND_PLOT_BOTTOM - TREND_PLOT_TOP),
  }))
  const linePoints = points.map((p) => `${p.x},${p.y}`).join(' ')
  return (
    <svg
      className="parking-trend-chart"
      viewBox={`0 0 ${TREND_W} ${TREND_H}`}
      role="img"
      aria-label="月別の違反車両台数推移（直近12か月）"
    >
      <line
        className="parking-trend-baseline"
        x1={TREND_PAD_X}
        y1={TREND_PLOT_BOTTOM}
        x2={TREND_W - TREND_PAD_X}
        y2={TREND_PLOT_BOTTOM}
      />
      <polyline className="parking-trend-line" points={linePoints} fill="none" />
      {points.map((p) => (
        <g key={p.key}>
          <title>{`${p.fullLabel}: ${p.count}件`}</title>
          <circle className="parking-trend-dot" cx={p.x} cy={p.y} r="4" />
          <text className="parking-trend-value-text" x={p.x} y={p.y - 8} textAnchor="middle">
            {p.count}
          </text>
          <text className="parking-trend-month-text" x={p.x} y={TREND_MONTH_Y} textAnchor="middle">
            {p.shortLabel}
          </text>
        </g>
      ))}
    </svg>
  )
}

// ランキング（横棒）。テナント別・車別の両方で使う共通部品
export function RankingBarList({ items, emptyText = '該当するデータがありません。' }) {
  if (items.length === 0) return <p className="ui-empty parking-ranking-empty">{emptyText}</p>
  const max = Math.max(1, ...items.map((i) => i.count))
  return (
    <ol className="parking-ranking-list">
      {items.map((item, i) => (
        <li className="parking-ranking-row" key={item.key} title={`${item.label}: ${item.count}件`}>
          <span className="parking-ranking-rank">{i + 1}</span>
          <span className="parking-ranking-label">{item.label}</span>
          <span className="parking-ranking-track">
            <span className="parking-ranking-bar" style={{ width: `${(item.count / max) * 100}%` }} />
          </span>
          <span className="parking-ranking-value">{item.count}</span>
        </li>
      ))}
    </ol>
  )
}
