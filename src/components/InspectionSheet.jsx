import { INSPECTION_ITEMS, INSPECTION_SHEET_COLUMNS, JUDGEMENT_MARKS, weekdayInfo } from '../lib/reports'
import './InspectionSheet.css'

// 自主検査表（日常）を紙の様式に寄せたA4縦1枚として組む、PDF出力専用の表示コンポーネント。
// 紙の様式が「実施日時」を16列しか持たないため、1ページ＝半月（1〜16日 / 17日〜末日）で
// 分ける。画面には出さず、PDF化のときだけ画面外で描画して html2canvas で撮る。
const SHEET_COLUMNS = INSPECTION_SHEET_COLUMNS

// 各項目のセル。紙の記入例（添付資料）に合わせ、記録がある日は良好な項目にも○を入れる
// （様式の注意書きは「良好なら確認箇所一斉に○」だが、実際の運用は全項目に○を書いている）。
function itemMark(rec, key) {
  if (!rec || rec.closed) return ''
  return JUDGEMENT_MARKS[rec.items?.[key] || 'ok']
}

// 「点検箇所一斉」の行。休館日は点検自体をしていないので「休」を置いて空欄と区別する
function allClearMark(rec) {
  if (!rec) return ''
  if (rec.closed) return '休'
  return rec.all_clear ? '○' : ''
}

function CheckBox({ checked }) {
  return <span className={`ins-checkbox${checked ? ' is-checked' : ''}`}>{checked ? '✓' : ''}</span>
}

export default function InspectionSheet({
  building,
  month,
  range,
  byDate,
  holidays,
  periodicResult,
  confirmedBy,
}) {
  const monthNum = Number(month.slice(5, 7))
  const groups = [...new Set(INSPECTION_ITEMS.map((i) => i.group))]
  // 16列に満たない分は空セルで埋め、どの半月でも同じ幅・同じ位置に罫線が来るようにする
  const columns = Array.from({ length: SHEET_COLUMNS }, (_, i) => range.days[i] || null)

  return (
    <div className="ins-sheet">
      <div className="ins-sheet-title">
        <span className="ins-sheet-building">
          ビル名 <strong>{building}</strong>
        </span>
        <span className="ins-sheet-heading">
          （ {month.slice(0, 4)} 年 {monthNum} 月）自主検査表(日常)
        </span>
        <span className="ins-sheet-range">
          {range.from}〜{range.to}日
        </span>
      </div>

      <table className="ins-sheet-table">
        <colgroup>
          <col className="ins-col-group" />
          <col className="ins-col-item" />
          {columns.map((_, i) => (
            <col className="ins-col-day" key={i} />
          ))}
        </colgroup>
        <tbody>
          <tr className="ins-row-head">
            <th colSpan={2}>実施責任者</th>
            <td colSpan={7}>防火管理者・火元責任者</td>
            <td colSpan={4}>担当範囲</td>
            <td colSpan={5}>別表1のとおり</td>
          </tr>

          <tr className="ins-row-days">
            <th colSpan={2}>実施日時</th>
            {columns.map((date, i) => {
              const wd = date ? weekdayInfo(date, holidays) : null
              return (
                <td key={i} className={wd ? wd.className : undefined}>
                  {date && (
                    <>
                      <span className="ins-day-num">{Number(date.slice(-2))}</span>
                      <span className="ins-day-wd">{wd.label}</span>
                    </>
                  )}
                </td>
              )
            })}
          </tr>

          <tr className="ins-row-inspector">
            <th colSpan={2}>点検者名</th>
            {columns.map((date, i) => (
              <td key={i}>{date ? byDate.get(date)?.inspector || '' : ''}</td>
            ))}
          </tr>

          <tr className="ins-row-allclear">
            <th colSpan={2}>点検箇所一斉</th>
            {columns.map((date, i) => (
              <td key={i} className="ins-mark">
                {date ? allClearMark(byDate.get(date)) : ''}
              </td>
            ))}
          </tr>

          {groups.map((group) => {
            const items = INSPECTION_ITEMS.filter((i) => i.group === group)
            return items.map((item, idx) => (
              <tr className="ins-row-item" key={item.key}>
                {idx === 0 && (
                  // 紙と同じ縦書きの見出し。writing-mode は html2canvas での再現が不安定なため、
                  // 1文字ずつブロックで積んで縦組みに見せる
                  <th className="ins-group" rowSpan={items.length} scope="rowgroup">
                    {[...group].map((ch, ci) => (
                      <span key={ci}>{ch}</span>
                    ))}
                  </th>
                )}
                <th className="ins-item" scope="row">
                  {item.label}
                </th>
                {columns.map((date, i) => (
                  <td key={i} className="ins-mark">
                    {date ? itemMark(byDate.get(date), item.key) : ''}
                  </td>
                ))}
              </tr>
            ))
          })}

          <tr className="ins-row-periodic">
            <th colSpan={2}>定期点検</th>
            <td colSpan={SHEET_COLUMNS}>
              6月及び12月の定期点検結果については、
              <span className={`ins-choice${periodicResult === 'ok' ? ' is-on' : ''}`}>
                <CheckBox checked={periodicResult === 'ok'} /> 支障無し
              </span>
              <span className={`ins-choice${periodicResult === 'ng' ? ' is-on' : ''}`}>
                <CheckBox checked={periodicResult === 'ng'} /> 支障有り
              </span>
            </td>
          </tr>

          <tr className="ins-row-confirm">
            <td colSpan={12} className="ins-blank" />
            <th colSpan={3}>防火管理者確認</th>
            <td colSpan={3} className="ins-confirm-box">
              {confirmedBy || ''}
            </td>
          </tr>
        </tbody>
      </table>

      <div className="ins-sheet-notes">
        <p>備考【不備・欠陥がある場合は、直ちに防火管理者に報告します。】</p>
        <p>凡例【○－良、×－不良、◎－即時改修、休－休館日】</p>
        <p>※ 該当項目を点検後記入する。</p>
        <p>※ 重専任要件の日常監視については、点検可能項目を点検すること。</p>
        <p>※ 不備が有る場合は、項目に×とし、良好の場合は、確認箇所一斉に○とすること。</p>
      </div>
    </div>
  )
}
