import { meterMonthLabel } from '../lib/meter'
import { formatTaken, formatValue } from '../lib/meterMonth'
import './MeterPhotoSheet.css'

// 検針写真一覧（PDF出力専用。2026-10-20〜。FileMaker の「メータ写真の印刷」と同じ1ページ8枚）。
// 画面には出さず、PDF化のときだけ画面外で描画して html2canvas で撮る（残留塩素の記録表と同じ作り）。
// 写真の横に、メータ番号・シール表記・テナント・当月値（黄色）・撮影日時を並べる
export const METER_PHOTOS_PER_PAGE = 8

export default function MeterPhotoSheet({ month, items, pageIndex, pageCount }) {
  return (
    <div className="mps-sheet">
      <div className="mps-head">
        <h1>検針写真 {meterMonthLabel(month)}</h1>
        <span>
          {pageIndex + 1} / {pageCount}
        </span>
      </div>
      <div className="mps-grid">
        {items.map(({ row, url }) => (
          <div key={row.meter.id} className="mps-cell">
            <div className="mps-photo">{url ? <img src={url} alt="" /> : <span>写真なし</span>}</div>
            <div className="mps-info">
              <p className="mps-no">{row.meter.meter_no}</p>
              <p>{row.meter.seal_label || row.meter.room_name || ''}</p>
              <p>{row.tenant?.short_name || row.tenant?.name || ''}</p>
              <p className="mps-value">
                {row.entered ? formatValue(row.reading.value) : '未入力'}
                {row.meter.is_oa_meter && row.reading?.value2 != null ? ` / ${formatValue(row.reading.value2)}` : ''}
              </p>
              <p className="mps-taken">{row.photo ? `撮影 ${formatTaken(row.photo.taken_at)}` : ''}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
