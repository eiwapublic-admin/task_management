// 違反車両ダッシュボードの小さなグラフ部品（2026-08-25新規）。専用のグラフ描画
// ライブラリは入っていないため、プレーンなdiv+CSSで組む（dataviz方針: 棒は太さ上限
// 24px・データ側だけ4px角丸・基準線側は直角、隣接する棒は最低2px以上の隙間で
// 分離、直接ラベルは要点だけに絞る）。1系列のグラフのため凡例は置かず、
// カード見出し（呼び出し側）が「何のグラフか」を示す。

// 月別の件数推移（直近12か月・棒グラフ）。ピークの月だけ強調ラベルを付け、
// それ以外は上に小さく件数を出す（件数が小さい値域のため全件ラベルでも煩雑にならない）
export function MonthlyTrendChart({ data }) {
  const max = Math.max(1, ...data.map((d) => d.count))
  return (
    <div className="parking-trend-chart" role="img" aria-label="月別の違反車両台数推移（直近12か月）">
      {data.map((d) => (
        <div className="parking-trend-col" key={d.key} title={`${d.fullLabel}: ${d.count}件`}>
          <span className="parking-trend-value">{d.count}</span>
          <div className="parking-trend-bar-track">
            <div className="parking-trend-bar" style={{ height: `${(d.count / max) * 100}%` }} />
          </div>
          <span className="parking-trend-month">{d.shortLabel}</span>
        </div>
      ))}
    </div>
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
