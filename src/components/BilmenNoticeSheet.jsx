import { formatTimeRange } from '../lib/bilmen'
import './BilmenNoticeSheet.css'

const WEEKDAY_LABELS_LONG = ['日', '月', '火', '水', '木', '金', '土']

function formatLongDate(date) {
  const d = new Date(`${date}T00:00:00Z`)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  return `${y}年 ${m}月 ${day}日 ${WEEKDAY_LABELS_LONG[d.getUTCDay()]}曜日`
}

// 作業予定連絡票（EV掲示・投函・メール添付用。docs/bilmen-plan.md 8-2）。A4縦。
// 件数が多い月は呼び出し元（フック）でページ分割し、このコンポーネントは
// 1ページ分（items）だけを受け取って描く。番号は全ページ通しにするため
// startIndex（0始まり）を受け取る。
export default function BilmenNoticeSheet({ month, buildingName, items, startIndex, outputDate, isLastPage }) {
  const [y, m] = month.split('-').map(Number)

  return (
    <div className="bno-sheet">
      <div className="bno-header">
        <span className="bno-to">テナント各位</span>
        <span className="bno-output-date">{outputDate}</span>
      </div>
      <h1 className="bno-heading">
        {y}年{m}月度 {buildingName} メンテナンス・イベントのお知らせ
      </h1>

      <div className="bno-list">
        {items.map((it, idx) => (
          <div key={it.id} className="bno-item">
            <div className="bno-item-title">
              <span className="bno-item-no">{startIndex + idx + 1}.</span> {it.title}
              {it.title_note && <span className="bno-item-note">（{it.title_note}）</span>}
            </div>
            {it.content && <p className="bno-item-content">{it.content}</p>}
            <dl className="bno-item-rows">
              <div className="bno-item-row">
                <dt>(1) 日時</dt>
                <dd>
                  <span className="bno-date">{formatLongDate(it.plan_date)}</span>
                  <span className="bno-time">　{formatTimeRange(it.plan_start, it.plan_end)}</span>
                </dd>
              </div>
              <div className="bno-item-row">
                <dt>(2) 場所</dt>
                <dd>{it.place || ''}</dd>
              </div>
              <div className="bno-item-row">
                <dt>(3) 担当会社</dt>
                <dd>{it.vendor_name || ''}</dd>
              </div>
              {it.notice && (
                <div className="bno-item-row">
                  <dt>(4) 留意事項</dt>
                  <dd className="bno-item-notice">{it.notice}</dd>
                </div>
              )}
            </dl>
          </div>
        ))}
      </div>

      {isLastPage && <p className="bno-footer">{buildingName}管理事務所</p>}
    </div>
  )
}
