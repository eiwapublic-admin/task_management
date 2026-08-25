// 残留塩素濃度の推移グラフ（3施設×過去3年・複数系列の折れ線グラフ。2026-08-25新規）。
// 専用のグラフ描画ライブラリは使わずSVGで組む（dataviz方針: 系列ごとに固定順の識別色を
// 割り当て、2系列以上は必ず凡例を表示する。欠測月（その施設でその月に測定が無い）は
// その区間だけ線を描かず、値がある点だけ丸マーカーを打つ）

const W = 700
const H = 190
// Y軸ラベルがグラフの線・点と重なって読みにくいとの指摘（2026-08-25）を受け、
// 左側にラベル専用の余白（PAD_LEFT）を確保し、プロット領域はその外側から描く
const PAD_LEFT = 42
const PAD_RIGHT = 14
const PLOT_TOP = 18
const PLOT_BOTTOM = 150
const MONTH_LABEL_Y = 172
// Y軸の横線の間隔（2026-08-25。グレーの点線を0.1刻みで引いてほしいとの依頼）
const Y_GRID_STEP = 0.1

export function ChlorineTrendChart({ months, series, standardValue }) {
  const n = months.length
  const step = n > 1 ? (W - PAD_LEFT - PAD_RIGHT) / (n - 1) : 0
  const allValues = series.flatMap((s) => s.values.filter((v) => v != null))
  const rawMax = Math.max(0.2, standardValue || 0, ...allValues)
  const yMax = Math.ceil(rawMax * 10) / 10
  const x = (i) => PAD_LEFT + i * step
  const y = (v) => PLOT_BOTTOM - (v / yMax) * (PLOT_BOTTOM - PLOT_TOP)

  // 欠測（null）で線が途切れるよう、値がある区間だけをsegmentに分ける
  const seriesWithSegments = series.map((s) => {
    const segments = []
    let current = []
    s.values.forEach((v, i) => {
      if (v == null) {
        if (current.length) segments.push(current)
        current = []
      } else {
        current.push({ i, v })
      }
    })
    if (current.length) segments.push(current)
    return { ...s, segments }
  })

  const showStandard = standardValue != null && standardValue <= yMax
  const isStandardValue = (v) => showStandard && Math.abs(v - standardValue) < 1e-9

  // Y軸のグリッド線（0.1刻み）。基準線（0.1mg/L）と同じ位置に重なる線は基準線側に
  // 譲って引かない（2026-08-25）
  const yGridSteps = []
  for (let v = Y_GRID_STEP; v < yMax - 1e-9; v += Y_GRID_STEP) {
    const rounded = Math.round(v * 10) / 10
    if (isStandardValue(rounded)) continue
    yGridSteps.push(rounded)
  }

  // Y軸の目盛りラベル（0・0.1刻み・yMax。線ごとに数値を表示してほしいとの依頼。
  // 2026-08-25）。基準線（0.1mg/L）の位置は「基準0.1」の専用ラベル側に任せる
  const yLabelSteps = []
  for (let v = 0; v <= yMax + 1e-9; v += Y_GRID_STEP) {
    const rounded = Math.round(v * 10) / 10
    if (isStandardValue(rounded)) continue
    yLabelSteps.push(rounded)
  }

  // X軸は毎年1月・6月にラベルと縦線を出す（2026-08-25。以前は詰まらないよう
  // 6か月おきに間引いていたが、年月の節目として分かりやすい1月・6月に固定した）
  const xTickIndexes = months.reduce((acc, mo, i) => {
    const m = mo.key.slice(5, 7)
    if (m === '01' || m === '06') acc.push(i)
    return acc
  }, [])

  return (
    <div className="chlorine-trend-wrap">
      <ul className="chlorine-trend-legend">
        {series.map((s) => (
          <li className="chlorine-trend-legend-item" key={s.key}>
            <span className="chlorine-trend-legend-swatch" style={{ background: s.color }} />
            {s.label}
          </li>
        ))}
      </ul>
      <svg
        className="chlorine-trend-chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="残留塩素濃度の推移（過去3年・3施設）"
      >
        {yGridSteps.map((v) => (
          <line
            key={v}
            className="chlorine-trend-ygrid"
            x1={PAD_LEFT}
            y1={y(v)}
            x2={W - PAD_RIGHT}
            y2={y(v)}
          />
        ))}
        {xTickIndexes.map((i) => (
          <line
            key={months[i].key}
            className="chlorine-trend-xgrid"
            x1={x(i)}
            y1={PLOT_TOP}
            x2={x(i)}
            y2={PLOT_BOTTOM}
          />
        ))}
        <line className="chlorine-trend-baseline" x1={PAD_LEFT} y1={PLOT_BOTTOM} x2={W - PAD_RIGHT} y2={PLOT_BOTTOM} />
        {showStandard && (
          <>
            <line
              className="chlorine-trend-standard-line"
              x1={PAD_LEFT}
              y1={y(standardValue)}
              x2={W - PAD_RIGHT}
              y2={y(standardValue)}
            />
            {/* グラフの線・点と重ならないよう、プロット領域の外側（左）に出す（2026-08-25） */}
            <text
              className="chlorine-trend-standard-label"
              x={PAD_LEFT - 6}
              y={y(standardValue) - 4}
              textAnchor="end"
            >
              基準{standardValue}
            </text>
          </>
        )}
        {yLabelSteps.map((v) => (
          <text
            key={v}
            className="chlorine-trend-axis-label"
            x={PAD_LEFT - 6}
            y={v === 0 ? PLOT_BOTTOM + 12 : y(v) - 4}
            textAnchor="end"
          >
            {v.toFixed(1)}
          </text>
        ))}
        {xTickIndexes.map((i) => (
          <text key={months[i].key} className="chlorine-trend-month-text" x={x(i)} y={MONTH_LABEL_Y} textAnchor="middle">
            {months[i].shortLabel}
          </text>
        ))}
        {seriesWithSegments.map((s) => (
          <g key={s.key}>
            {s.segments.map((seg, si) => (
              <polyline
                key={si}
                className="chlorine-trend-line"
                style={{ stroke: s.color }}
                fill="none"
                points={seg.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')}
              />
            ))}
            {s.segments.flat().map((p) => (
              <g key={p.i}>
                <title>{`${months[p.i].fullLabel} ${s.label}: ${p.v.toFixed(2)}mg/L`}</title>
                <circle className="chlorine-trend-dot" style={{ fill: s.color }} cx={x(p.i)} cy={y(p.v)} r="3" />
              </g>
            ))}
          </g>
        ))}
      </svg>
    </div>
  )
}
