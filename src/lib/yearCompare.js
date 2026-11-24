// 前年比較グラフ（古紙回収・廃棄物。2026-11-24〜）の共通計算。
// 年度は4月始まり3月締め。月の合計は呼び出し側で 'YYYY-MM' -> kg の Map にして渡す。

// 年度内の月一覧（4月→翌3月の順）
export function fiscalMonthsOf(fiscalYear) {
  const months = []
  for (let i = 0; i < 12; i++) {
    const m = ((3 + i) % 12) + 1
    const y = m >= 4 ? fiscalYear : fiscalYear + 1
    months.push(`${y}-${String(m).padStart(2, '0')}`)
  }
  return months
}

// 前年同月の 'YYYY-MM'
export function sameMonthLastYear(month) {
  return `${Number(month.slice(0, 4)) - 1}${month.slice(4)}`
}

// 年度合計と、年度が終わっていないときの推計値。
// 推計＝「締まった月（今月より前の月）のうち実績のある月」の平均 × 12か月。
// 実績のある月だけで平均するのは、画面の「月平均（実績nか月）」と同じ考え方（未入力の月を0と
// みなすと推計が低く出すぎるため）。今月は途中なので平均には入れない。
// 推計が今の実績を下回る場合は実績を推計値とする。
//   currentMonth: 今日の 'YYYY-MM'（JST）
//   戻り値: { total, estimated: number|null, basisMonths }
export function fiscalYearTotals(fiscalYear, monthTotals, currentMonth) {
  const months = fiscalMonthsOf(fiscalYear)
  const total = months.reduce((sum, m) => sum + (monthTotals.get(m) || 0), 0)
  const lastMonth = months[11]
  // 最終月（3月）がまだ締まっていない年度＝最新年度
  if (currentMonth > lastMonth) return { total, estimated: null, basisMonths: 0 }
  const closed = months.filter((m) => m < currentMonth && (monthTotals.get(m) || 0) > 0)
  if (closed.length === 0) return { total, estimated: null, basisMonths: 0 }
  const avg = closed.reduce((sum, m) => sum + monthTotals.get(m), 0) / closed.length
  return { total, estimated: Math.max(total, avg * 12), basisMonths: closed.length }
}
