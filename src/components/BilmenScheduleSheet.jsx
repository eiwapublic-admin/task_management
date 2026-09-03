import { daysInMonth, weekdayInfo } from '../lib/reports'
import { formatMonthDay, formatTimeRange } from '../lib/bilmen'
import './BilmenScheduleSheet.css'

// 日程表（1階掲示用。docs/bilmen-plan.md 8-1）。A4縦1枚。
// その月の全日を1行（複数件ある日は行内に積む）とし、日程表そのものは
// 「報知対象☑ かつ 予定日付あり かつ 中止でない」行だけを載せる（3-4）。
// 画面には出さず、PDF化のときだけ画面外で描画して html2canvas で撮る
// （print-and-pdf-download スキル。他の帳票と同じ方式）。
export default function BilmenScheduleSheet({ month, buildingName, items, holidays, outputDate }) {
  const total = daysInMonth(month)
  const [y, m] = month.split('-').map(Number)

  const byDate = new Map()
  for (const it of items) {
    if (!byDate.has(it.plan_date)) byDate.set(it.plan_date, [])
    byDate.get(it.plan_date).push(it)
  }

  const days = Array.from({ length: total }, (_, i) => {
    const d = String(i + 1).padStart(2, '0')
    const date = `${month}-${d}`
    const rows = [...(byDate.get(date) || [])].sort((a, b) => (a.plan_start || '').localeCompare(b.plan_start || ''))
    return { date, rows }
  })

  // 縦の余白を全日で均等割りし、複数件ある日はその件数分だけ行を積む（実質1行=1件）。
  // 13-12: 現行も1枚に収まる大きさに実物合わせで調整してきた運用のため、行数（=総行数）で
  // 均等割りする方式を踏襲する。若干の余裕を持たせるため、可能な限りコンパクトな
  // フォントサイズをCSS側で先に決め打ちしてある
  const totalLines = days.reduce((sum, d) => sum + Math.max(1, d.rows.length), 0)
  const rowHeight = `calc((277mm - 12mm - 8mm - 12mm) / ${totalLines})`

  return (
    <div className="bsch-sheet">
      <div className="bsch-title">
        <span className="bsch-heading">
          {y}年{String(m).padStart(2, '0')}月 {buildingName} メンテナンス・イベント予定表
        </span>
        <span className="bsch-output-date">{outputDate}</span>
      </div>

      <table className="bsch-table" style={{ '--bsch-row-h': rowHeight }}>
        <colgroup>
          <col className="bsch-col-date" />
          <col className="bsch-col-time" />
          <col className="bsch-col-title" />
          <col className="bsch-col-vendor" />
          <col className="bsch-col-enter" />
          <col className="bsch-col-notice" />
        </colgroup>
        <thead>
          <tr className="bsch-row-head">
            <th />
            <th>予定時刻</th>
            <th>作業</th>
            <th>担当会社</th>
            <th>入室あり*</th>
            <th>注意事項</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => {
            const wd = weekdayInfo(d.date, holidays)
            const rowClass = `bsch-day-row ${wd.className}`.trim()
            if (d.rows.length === 0) {
              return (
                <tr key={d.date} className={rowClass}>
                  <td className="bsch-date-cell">
                    {formatMonthDay(d.date)} ({wd.label})
                    {wd.holidayName && <span className="bsch-holiday-name">{wd.holidayName}</span>}
                  </td>
                  <td />
                  <td />
                  <td />
                  <td />
                  <td />
                </tr>
              )
            }
            return d.rows.map((it, idx) => (
              <tr key={it.id} className={rowClass}>
                {idx === 0 && (
                  <td className="bsch-date-cell" rowSpan={d.rows.length}>
                    {formatMonthDay(d.date)} ({wd.label})
                    {wd.holidayName && <span className="bsch-holiday-name">{wd.holidayName}</span>}
                  </td>
                )}
                <td className="bsch-time-cell">{formatTimeRange(it.plan_start, it.plan_end)}</td>
                <td className="bsch-title-cell">
                  {it.title}
                  {it.title_note && <span className="bsch-title-note">（{it.title_note}）</span>}
                </td>
                <td>{it.vendor_name || ''}</td>
                <td className="bsch-mark">{it.enter_room ? '✓' : ''}</td>
                <td className="bsch-notice-cell">{it.notice || ''}</td>
              </tr>
            ))
          })}
        </tbody>
      </table>

      <p className="bsch-footnote">入室あり*：各テナント様のお部屋に入室して作業いたします。</p>
    </div>
  )
}
