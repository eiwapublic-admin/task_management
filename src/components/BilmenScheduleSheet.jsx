import { daysInMonth, weekdayInfo } from '../lib/reports'
import { formatMonthDay, formatTimeRange, formatRevisionLabel } from '../lib/bilmen'
import './BilmenScheduleSheet.css'

// 日程表（1階掲示用。docs/bilmen-plan.md 8-1）。A4縦1枚。
// その月の全日を1行（複数件ある日は行内に積む）とし、日程表そのものは
// 「報知対象☑ かつ 予定日付あり かつ 中止でない」行だけを載せる（3-4）。
// 画面には出さず、PDF化のときだけ画面外で描画して html2canvas で撮る
// （print-and-pdf-download スキル。他の帳票と同じ方式）。
//
// 2026-09-14、<table>のrowSpanをCSS Gridに書き換えた。1日に複数件ある日の日付セルを
// rowSpanで結合していたが、実機（Safari/WebKit）で「セルの高さが正しく積算されず
// 文字の下半分が欠ける」「行の背景の塗りが日付の上に被さる」という、rowSpan固有の
// 描画不具合が2件続けて見つかった（table-layout:fixed・colgroup・rowSpanの組み合わせは
// エンジンごとの実装差が大きい）。CSS Gridの `grid-row: span N` は、テーブルの行占有の
// 仕組みに頼らずとも「複数行にまたがるセル」を表現できるため、根本的に作り替えた。
// 列幅・行の高さの計算方法・見た目は変えていない（各セルを .bsch-cell な div にして
// grid-template-columns で列を、grid-auto-rows で行の高さを揃える）
export default function BilmenScheduleSheet({ month, buildingName, items, holidays, outputDate, revisedOn }) {
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
        {/* 差し替え版のときだけ出す「（yyyy/mm/dd 変更版）」（5-4）。
            この見出し行は高さ12mm固定＋シートが overflow:hidden で、その12mmは
            表の行高の計算（277mm - 12mm - 8mm - 12mm）にも効いている。見出しの直後に
            並べると長い建物名で折り返して**2行目が切れて消える**ため、右端で出力日の上に
            積む形にした（見た目上はタイトル行の右側に出る） */}
        <span className="bsch-title-right">
          {formatRevisionLabel(revisedOn) && (
            <span className="bsch-revision">{formatRevisionLabel(revisedOn)}</span>
          )}
          <span className="bsch-output-date">{outputDate}</span>
        </span>
      </div>

      <div className="bsch-table" style={{ '--bsch-row-h': rowHeight }}>
        <div className="bsch-cell bsch-head-cell bsch-date-cell" />
        <div className="bsch-cell bsch-head-cell bsch-time-cell">予定時刻</div>
        <div className="bsch-cell bsch-head-cell bsch-title-cell">作業</div>
        <div className="bsch-cell bsch-head-cell bsch-vendor-cell">担当会社</div>
        <div className="bsch-cell bsch-head-cell bsch-mark">入室*</div>
        <div className="bsch-cell bsch-head-cell bsch-notice-cell">注意事項</div>

        {days.map((d) => {
          const wd = weekdayInfo(d.date, holidays)
          const rowClass = `bsch-day-row ${wd.className}`.trim()
          const span = Math.max(1, d.rows.length)

          const dateCell = (
            <div
              key={`${d.date}-date`}
              className={`bsch-cell bsch-date-cell ${rowClass}`}
              style={{ gridRow: `span ${span}` }}
            >
              {formatMonthDay(d.date)} ({wd.label})
            </div>
          )

          if (d.rows.length === 0) {
            return (
              <div key={d.date} style={{ display: 'contents' }}>
                {dateCell}
                <div className={`bsch-cell bsch-time-cell ${rowClass}`} />
                <div className={`bsch-cell bsch-title-cell ${rowClass}`} />
                <div className={`bsch-cell bsch-vendor-cell ${rowClass}`} />
                <div className={`bsch-cell bsch-mark ${rowClass}`} />
                <div className={`bsch-cell bsch-notice-cell ${rowClass}`} />
              </div>
            )
          }

          return (
            <div key={d.date} style={{ display: 'contents' }}>
              {dateCell}
              {d.rows.map((it) => (
                <div key={it.id} style={{ display: 'contents' }}>
                  <div className={`bsch-cell bsch-time-cell ${rowClass}`}>
                    {formatTimeRange(it.plan_start, it.plan_end)}
                  </div>
                  <div className={`bsch-cell bsch-title-cell ${rowClass}`}>
                    {it.title}
                    {it.title_note && <span className="bsch-title-note">（{it.title_note}）</span>}
                  </div>
                  <div className={`bsch-cell bsch-vendor-cell ${rowClass}`}>{it.vendor_name || ''}</div>
                  <div className={`bsch-cell bsch-mark ${rowClass}`}>{it.enter_room ? '✓' : ''}</div>
                  <div className={`bsch-cell bsch-notice-cell ${rowClass}`}>{it.notice || ''}</div>
                </div>
              ))}
            </div>
          )
        })}
      </div>

      <p className="bsch-footnote">*入室：各テナント様のお部屋に入室して作業いたします。</p>
    </div>
  )
}
