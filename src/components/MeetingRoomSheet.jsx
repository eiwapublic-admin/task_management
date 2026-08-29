import { Fragment } from 'react'
import { weekdayInfo } from '../lib/reports'
import './MeetingRoomSheet.css'

// 会議室利用申込書（会議室予約表）を紙の様式に寄せたA4縦1枚として組む、PDF出力専用の
// 表示コンポーネント（2026-08-29。備後町コイズミビル５階の会議室予約表という、
// 特定のビル・部屋専用の固定様式なので、タイトル・連絡先はハードコードでよい）。
// 画面には出さず、PDF化のときだけ画面外で描画して html2canvas で撮る
// （src/components/InspectionSheet.jsx と同じ作り方）。

const HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17] // 9:00〜18:00（30分刻み。最終列は17:30）
const SLOT_COUNT = HOURS.length * 2

// 行の背景色。土曜＝青、日曜・祝日・休館日＝ピンク（依頼元の指定。2026-08-29）
function rowClassName(date, holidays, closedDays) {
  const wd = weekdayInfo(date, holidays)
  if (wd.className === 'is-holiday' || closedDays.has(date)) return 'mr-row-pink'
  if (wd.className === 'is-saturday') return 'mr-row-blue'
  return ''
}

export default function MeetingRoomSheet({ month, range, holidays, closedDays }) {
  const monthNum = Number(month.slice(5, 7))
  // 日の行の高さは半月あたりの日数（14〜16日）で変わるため、どちらの半月ページでも
  // 表がちょうどA4いっぱいに収まるよう、行数から逆算する（InspectionSheetは列数が
  // 常に16固定なのでこの計算は不要だったが、会議室予約表は行数が月ごとに変わるため必要）
  const rowHeight = `calc((277mm - 21mm - 13mm - 11mm - 7mm) / ${range.days.length})`

  return (
    <div className="mr-sheet" style={{ '--mr-row-h': rowHeight }}>
      <div className="mr-sheet-title">備後町コイズミビル５階　会議室利用申込書</div>
      <div className="mr-sheet-month-box">{month.slice(0, 4)}年{monthNum}月</div>

      <table className="mr-sheet-table">
        <colgroup>
          <col className="mr-col-date" />
          <col className="mr-col-wd" />
          {Array.from({ length: SLOT_COUNT }, (_, i) => (
            <col className="mr-col-time" key={i} />
          ))}
        </colgroup>
        <thead>
          <tr className="mr-row-hours">
            <th rowSpan={2}>日付</th>
            <th rowSpan={2}>曜日</th>
            {HOURS.map((h) => (
              <th colSpan={2} key={h}>{h}</th>
            ))}
          </tr>
          <tr className="mr-row-minutes">
            {HOURS.map((h) => (
              <Fragment key={h}>
                <th>00</th>
                <th>30</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* 記入例（10:00〜12:30の予約を書く見本）。列2つ分（9:00・9:30）を空けたあと、
              10:00〜12:30にあたる5列（10:00・10:30・11:00・11:30・12:00）をまたぐ */}
          <tr className="mr-row-example">
            <th colSpan={2}>記入例</th>
            <td colSpan={2} />
            <td className="mr-example-cell" colSpan={5}>
              <div className="mr-example-arrow">10：00 〜 12：30</div>
              <div className="mr-example-name">備後町ｺｲｽﾞﾐﾋﾞﾙ/鍵本(06-6251-9881）</div>
            </td>
            <td colSpan={SLOT_COUNT - 7} />
          </tr>

          {range.days.map((date) => (
            <tr className={rowClassName(date, holidays, closedDays)} key={date}>
              <td className="mr-date">{Number(date.slice(-2))}日</td>
              <td className="mr-wd">{weekdayInfo(date, holidays).label}</td>
              {Array.from({ length: SLOT_COUNT }, (_, i) => (
                <td key={i} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mr-sheet-note">※予定に変更が生じた際には修正をお願い致します。</p>
    </div>
  )
}
