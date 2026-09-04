import { daysInMonth, weekdayInfo } from '../lib/reports'
import { WASTE_FLOORS } from '../lib/waste'
import './WasteSheet.css'

// 廃棄物実測集計表（記入用の空欄シート。docs/waste-plan.md「修正依頼」2026-09-03）。A4縦1枚。
// 依頼元が現行使っている紙シートと同じ様式を再現し、あらかじめ印刷して手書きの
// 入力用紙として配布できるようにする（値は一切入れない。スキャン取込で使う既存データは
// 関係ない）。日曜・祝日の行だけ赤系で塗る（土曜の色分けは元の紙シートに無いため付けない）。
export default function WasteSheet({ month, holidays }) {
  const total = daysInMonth(month)
  const [y, m] = month.split('-').map(Number)
  const days = Array.from({ length: total }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)

  // 縦の余白を「日数分の行＋合計行」で均等割りする（見出し2段・区切り行は固定高さ）
  const totalLines = total + 1
  const rowHeight = `calc((297mm - 20mm - 10mm - 14mm - 3mm) / ${totalLines})`

  return (
    <div className="waste-sheet">
      <div className="waste-sheet-title">
        <span className="waste-sheet-heading">
          ■　BKBビル　廃棄物実測集計表　{y}年　{m}月
        </span>
        <span className="waste-sheet-unit">Kg</span>
      </div>

      <table className="waste-sheet-table" style={{ '--wsh-row-h': rowHeight }}>
        <colgroup>
          <col className="wsh-col-date" />
          <col className="wsh-col-weekday" />
          {WASTE_FLOORS.map((f) => (
            <col key={f} />
          ))}
          <col className="wsh-col-total" />
        </colgroup>
        <thead>
          <tr>
            <th rowSpan={2}>日</th>
            <th rowSpan={2}>曜日</th>
            <th colSpan={WASTE_FLOORS.length}>一般廃棄物</th>
            <th rowSpan={2}>合計</th>
          </tr>
          <tr>
            {WASTE_FLOORS.map((f) => (
              <th key={f}>{f}階</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((date, i) => {
            const wd = weekdayInfo(date, holidays)
            return (
              <tr key={date} className={wd.isRed ? 'is-holiday' : ''}>
                <td className="wsh-date-cell">{i + 1}</td>
                <td className="wsh-date-cell">{wd.label}</td>
                {WASTE_FLOORS.map((f) => (
                  <td key={f} />
                ))}
                <td />
              </tr>
            )
          })}
          <tr className="waste-sheet-spacer">
            <td colSpan={WASTE_FLOORS.length + 3} />
          </tr>
          <tr className="waste-sheet-total-row">
            <td colSpan={2}>合計</td>
            {WASTE_FLOORS.map((f) => (
              <td key={f} />
            ))}
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  )
}
