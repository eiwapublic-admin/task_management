import { dow, monthRange } from '../../../worker/lib/works/time.js'
import './AttendanceSheet.css'

// 出勤簿（A4 縦 1 枚。現行 FileMaker「出勤簿（新2022）」のレイアウトを再現。docs/eworks-plan.md 12章）
//   入力方法が「管理者が代理入力」のスタッフに配る、手書きの入力用の用紙として使う（2026-11-24 依頼元の要望）。
//   予定の時刻・時間・現場は薄い字で印字し、その上に本人が実際の時刻を書き込む。
//   出勤・退勤の記録（実績）がそろった区間は、実績の時刻を濃い字で出す。見出しは実績が 1 件もなければ「予定」、あれば「実績」（現行どおり）。
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']
const SUBTOTAL_SLOTS = 12 // 件名別小計の枠（3 列 × 4 行）

const hours = (min) => (min / 60).toFixed(2)
const hm = (t) => (t ? t.replace(/^0(\d)/, '$1') : '')

export default function AttendanceSheet({ month, sheet, holidays = {}, companyHolidays = {} }) {
  const { staff, shifts, leave } = sheet
  const { days } = monthRange(month)
  const [y, m] = month.split('-').map(Number)
  const monthText = `${y}年${m}月`
  const paid = new Set(sheet.paid_days || [])
  const special = new Set(sheet.special_days || [])

  const byDate = {}
  for (const s of shifts) (byDate[s.work_date] ||= []).push(s)
  const actualCount = shifts.filter((s) => s.actual_start && s.actual_end).length
  const minutesOf = (s) => (s.actual_minutes ?? s.minutes) || 0
  const totalMin = shifts.reduce((a, s) => a + minutesOf(s), 0)

  // 件名別小計（現場ごとの時間）
  const subtotals = []
  for (const s of shifts) {
    const name = s.site?.name || '（現場なし）'
    let row = subtotals.find((r) => r.name === name)
    if (!row) subtotals.push((row = { name, min: 0 }))
    row.min += minutesOf(s)
  }

  const p = leave?.period
  const rowH = `${216 / days}mm`

  return (
    <div className="att-sheet">
      <div className="att-head">
        <span className="att-title">出勤簿</span>
        <span className="att-kind">{actualCount ? '実績' : '予定'}</span>
        <span className="att-month">{monthText}</span>
        <span className="att-name">
          {staff.code} {staff.name}
        </span>
        <div className="att-leave">
          <div>
            <span className="att-leave-label">有休付与日数</span>
            <span className="att-leave-num">{p ? p.carry + p.grant : ''}</span>
            <span className="att-leave-sub">（内 繰越</span>
            <span className="att-leave-num">{p ? p.carry : ''}</span>
            <span>）</span>
          </div>
          <div>
            <span className="att-leave-label">今期間取得済日数</span>
            <span className="att-leave-num">{p ? p.taken : ''}</span>
            <span className="att-leave-sub">（内 当月</span>
            <span className="att-leave-num">{leave?.month_paid || ''}</span>
            <span>）</span>
          </div>
          <div>
            <span className="att-leave-label">残日数</span>
            <span className="att-leave-num">{p ? p.remain : ''}</span>
          </div>
          <div>
            <span className="att-leave-label">特別休暇取得日数</span>
            <span className="att-leave-num">{p ? p.special_taken : ''}</span>
            <span className="att-leave-sub">（内 当月</span>
            <span className="att-leave-num">{leave?.month_special || ''}</span>
            <span>）</span>
          </div>
        </div>
        <span className="att-col-title" style={{ left: '11.2mm' }}>日</span>
        <span className="att-col-title" style={{ left: '21.7mm' }}>祝日／休暇</span>
        <span className="att-col-title" style={{ left: '40.6mm' }}>作業時間</span>
        <span className="att-col-title" style={{ left: '57mm' }}>通常</span>
        <span className="att-col-title" style={{ left: '68.2mm' }}>残業</span>
        <span className="att-col-title" style={{ left: '77.4mm' }}>休日</span>
        <span className="att-col-title" style={{ left: '87.3mm' }}>作業内容１〜２</span>
        <span className="att-col-title" style={{ left: '190.6mm' }}>交通費</span>
      </div>

      <div className="att-rows">
        {Array.from({ length: days }, (_, i) => {
          const d = i + 1
          const date = `${month}-${String(d).padStart(2, '0')}`
          const w = dow(date)
          const holiday = holidays[date]
          const red = w === 0 || w === 6 || !!holiday
          const items = byDate[date] || []
          const notes = [holiday || companyHolidays[date], special.has(date) ? '特休' : paid.has(date) ? '有休' : null].filter(Boolean)
          return (
            <div key={date} className={`att-row${d % 2 === 0 ? ' is-even' : ''}`} style={{ height: rowH }}>
              <div className="att-c att-c-day">{d}</div>
              <div className={`att-c att-c-dow${red ? ' is-red' : ''}`}>{WEEKDAYS[w]}</div>
              <div className="att-c att-c-note">{notes.join('・')}</div>
              {['start', 'end', 'normal'].map((col) => (
                <div key={col} className={`att-c att-c-${col}`}>
                  {items.map((s) => {
                    const actual = !!(s.actual_start && s.actual_end)
                    const text = col === 'start' ? hm(actual ? s.actual_start : s.plan_start) : col === 'end' ? hm(actual ? s.actual_end : s.plan_end) : hours(minutesOf(s))
                    return (
                      <div key={s.id} className={actual ? 'att-v is-actual' : 'att-v'}>
                        {text}
                      </div>
                    )
                  })}
                </div>
              ))}
              <div className="att-c att-c-over" />
              <div className="att-c att-c-hol" />
              <div className="att-c att-c-work">
                {items.map((s) => (
                  <div key={s.id} className={s.actual_start && s.actual_end ? 'att-v att-site is-actual' : 'att-v att-site'}>
                    {s.site?.name || ''}
                  </div>
                ))}
              </div>
              <div className="att-c att-c-work">
                {items.map((s) => (
                  <div key={s.id} className="att-v att-site">
                    {s.telework ? 'テレワーク' : ''}
                  </div>
                ))}
              </div>
              <div className="att-c att-c-work" />
              <div className="att-c att-c-fare" />
            </div>
          )
        })}
      </div>

      <div className="att-foot">
        <div className="att-total" style={{ top: '3.5mm' }}>
          <span>通常時間計</span>
          <b>{hours(totalMin)}</b>
        </div>
        <div className="att-total" style={{ top: '11.8mm' }}>
          <span>残業時間計</span>
          <b>0.00</b>
        </div>
        <div className="att-total" style={{ top: '20.1mm' }}>
          <span>休日時間計</span>
          <b>0.00</b>
        </div>
        <div className="att-count">
          <span>実績件数</span>
          <b>{actualCount}</b>
        </div>
        <div className="att-sub-label">件名別小計</div>
        <div className="att-sub">
          {Array.from({ length: SUBTOTAL_SLOTS / 3 }, (_, r) => (
            <div key={r} className="att-sub-row">
              {[0, 1, 2].map((c) => {
                const it = subtotals[c * 4 + r]
                return (
                  <div key={c} className="att-sub-pair">
                    <div className="att-sub-name">{it?.name || ''}</div>
                    <div className="att-sub-hours">{it ? hours(it.min) : ''}</div>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
        <div className="att-right" style={{ top: '2.5mm' }}>交通費計</div>
        <div className="att-right" style={{ top: '11.2mm' }}>手当</div>
        <div className="att-right" style={{ top: '19.9mm' }}>皆勤</div>
        <div className="att-stamp-month">{monthText}</div>
        <div className="att-stamp-name">
          {staff.code} {staff.name}
        </div>
      </div>
    </div>
  )
}
