import {
  CHLORINE_JUDGEMENT_ITEMS,
  CHLORINE_STANDARD_MIN,
  formatConcentration,
  formatReportDate,
} from '../lib/reports'
import './ChlorineSheet.css'

// 残留塩素等検査実施記録表（PDF出力専用の表示コンポーネント。2026-08-10）。
// 現行アプリ（FileMaker）の帳票「P) 残留塩素濃度一覧表」に寄せたA4縦。
// 年間の測定（週1回＝約52件）は1枚に収まらないため、呼び出し側（useChlorinePdfExport）が
// CHLORINE_SHEET_ROWS 行ごとに分割し、このコンポーネントを1ページずつ描画する。
// 画面には出さず、PDF化のときだけ画面外で描画して html2canvas で撮る。

// 1ページに載せる行数。A4縦から見出し・表ヘッダ・ページ番号を引いた高さで決めている
export const CHLORINE_SHEET_ROWS = 38

// 'YYYY-MM-DD (火) 13:09' の形に整える（紙の帳票と同じ「点検日付＋時刻」）
function formatTestedAt(value) {
  const date = new Date(value).toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
  const time = new Date(value).toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  return `${formatReportDate(date)} ${time}`
}

// OK / NG。未選択（null）は空欄のままにする（記入漏れが分かるようにするため）
function judgementMark(value) {
  if (value === true) return 'OK'
  if (value === false) return 'NG'
  return ''
}

// {year}年{month}月（monthが無ければ年のみ。旧表示との後方互換用）
function formatHeaderYearMonth(year, month) {
  return month ? `${year}年${month}月` : `${year}年`
}

export default function ChlorineSheet({ building, year, month, rows, pageIndex, pageCount }) {
  return (
    <div className="chl-sheet">
      <h1 className="chl-sheet-heading">残留塩素等検査実施記録表</h1>

      {/* ヘッダ部：左端に特定建築物名・年月、右端に週1回検査／水道水質基準の注記を
          グレー文字で表示する（2026-08-14。以前は左右が逆だった） */}
      <div className="chl-sheet-subhead">
        <div className="chl-sheet-meta">
          <p className="chl-sheet-building">
            特定建築物名【 <strong>{building}</strong> 】
          </p>
          <p>{formatHeaderYearMonth(year, month)}</p>
        </div>
        <div className="chl-sheet-terms">
          <p>週1回検査</p>
          <p>水道水質基準：遊離残留塩素濃度として {CHLORINE_STANDARD_MIN.toFixed(1)}mg/L以上</p>
        </div>
      </div>

      <table className="chl-sheet-table">
        <colgroup>
          <col className="chl-col-date" />
          <col className="chl-col-inspector" />
          <col className="chl-col-place" />
          <col className="chl-col-value" />
          {CHLORINE_JUDGEMENT_ITEMS.map((item) => (
            <col className="chl-col-judge" key={item.key} />
          ))}
          <col className="chl-col-note" />
        </colgroup>
        <thead>
          <tr>
            <th className="chl-th-date">点検日付　時刻</th>
            <th>検査者</th>
            <th>検査場所</th>
            <th>塩素濃度</th>
            {CHLORINE_JUDGEMENT_ITEMS.map((item) => (
              <th key={item.key}>{item.label}</th>
            ))}
            <th className="chl-th-note">備考</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const value = formatConcentration(t.concentration)
            const below =
              t.concentration !== null &&
              t.concentration !== undefined &&
              Number(t.concentration) < CHLORINE_STANDARD_MIN
            return (
              <tr key={t.id}>
                <td className="chl-td-date">{formatTestedAt(t.tested_at)}</td>
                <td className="chl-td-inspector">{t.inspector || ''}</td>
                <td className="chl-td-place">{t.location || ''}</td>
                <td className={`chl-td-value${below ? ' is-below' : ''}`}>
                  {value && (
                    <>
                      {value}
                      <span className="chl-unit">mg/L</span>
                    </>
                  )}
                </td>
                {CHLORINE_JUDGEMENT_ITEMS.map((item) => (
                  <td key={item.key}>{judgementMark(t[item.key])}</td>
                ))}
                <td className="chl-td-note">{t.note || ''}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {pageCount > 1 && (
        <div className="chl-sheet-foot">
          {pageIndex + 1} / {pageCount} ページ
        </div>
      )}
    </div>
  )
}
