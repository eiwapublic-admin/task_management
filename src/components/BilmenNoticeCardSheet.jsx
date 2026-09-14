import { formatTimeRange } from '../lib/bilmen'
import './BilmenNoticeCardSheet.css'

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土']

// カードの見出し帯に出す日付。紙面が狭いので「09/04 金」まで詰める
function formatShortDate(date) {
  const d = new Date(`${date}T00:00:00Z`)
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${m}/${day} ${WEEKDAY_LABELS[d.getUTCDay()]}`
}

// 作業予定連絡票「カード版」（docs/bilmen-plan.md 8-2）。A4縦。
// 1件＝1枚のカードを2段組で並べるレイアウト。従来版（BilmenNoticeSheet）と
// 選んで出せる2つ目の版として2026-09-14に追加した。
//
// 従来版との違いは見た目だけで、載せる情報・報知対象の絞り込み・ページ分割の
// 考え方（呼び出し元のフックで実測してから割る）は共通。ただしページ割りは
// 「1件ずつ」ではなく「2件ずつ（＝グリッドの1行）」単位で詰める必要があるため、
// フック側に専用の詰め込み処理がある（useBilmenNoticePdfExport.jsx）。
export default function BilmenNoticeCardSheet({
  month,
  buildingName,
  items,
  startIndex,
  outputDate,
  isLastPage,
  note,
  measuring,
}) {
  const [y, m] = month.split('-').map(Number)
  // 今月の注釈は1ページ目だけに出す（従来版と同じ。8-2）
  const isFirstPage = startIndex === 0

  return (
    <div className={`bnc-sheet${measuring ? ' is-measuring' : ''}`}>
      <div className="bnc-top">
        <span>テナント各位</span>
        <span>{outputDate}</span>
      </div>

      <div className="bnc-head">
        <div className="bnc-month">
          <span className="bnc-month-year">{y}年</span>
          <span className="bnc-month-num">{m}</span>
          <span className="bnc-month-label">月度</span>
        </div>
        <h1 className="bnc-title">{buildingName}　メンテナンス・イベントのお知らせ</h1>
      </div>

      {isFirstPage && note && <p className="bnc-note">{note}</p>}

      <div className="bnc-grid">
        {items.map((it, idx) => (
          <div key={it.id} className="bnc-card">
            <div className="bnc-strip">
              <span className="bnc-strip-no">{String(startIndex + idx + 1).padStart(2, '0')}</span>
              <span className="bnc-strip-date">{formatShortDate(it.plan_date)}</span>
              <span className="bnc-strip-time">{formatTimeRange(it.plan_start, it.plan_end)}</span>
            </div>
            <div className="bnc-body">
              <div className="bnc-name">
                {it.title}
                {it.title_note && <span className="bnc-name-note">　／ {it.title_note}</span>}
              </div>
              {it.content && <p className="bnc-desc">{it.content}</p>}
              <dl className="bnc-kv">
                {it.place && (
                  <>
                    <dt>場所</dt>
                    <dd>{it.place}</dd>
                  </>
                )}
                {it.vendor_name && (
                  <>
                    <dt>担当</dt>
                    <dd>{it.vendor_name}</dd>
                  </>
                )}
              </dl>
              {it.notice && <div className="bnc-caution">{it.notice}</div>}
            </div>
          </div>
        ))}
      </div>

      {isLastPage && (
        <div className="bnc-foot">
          <span>ご不明な点は管理事務所までお問い合わせください。</span>
          <span>{buildingName}管理事務所</span>
        </div>
      )}
    </div>
  )
}
