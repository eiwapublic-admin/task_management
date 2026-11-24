// 打刻の修正申請の一覧（管理者: 承認・却下／本人: 取り下げ）。要確認の画面と日の画面で共通
import { useState } from 'react'
import { api, WEEKDAYS } from '../lib/api.js'
import { dow } from '../../../worker/lib/works/time.js'

const STATUS = { pending: '承認待ち', approved: '承認済み', rejected: '却下', cancelled: '取り下げ' }
const BADGE = { pending: 'is-warn', approved: 'is-current', rejected: 'is-danger', cancelled: '' }
const dayLabel = (d) => `${Number(d.slice(5, 7))}月${Number(d.slice(8))}日（${WEEKDAYS[dow(d)]}）`

export default function PunchRequestList({ items, admin = false, onChanged, onOpen }) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const act = async (r, action) => {
    let note = ''
    if (action === 'reject') {
      note = window.prompt('却下の理由（本人に表示されます。空欄でも可）', '')
      if (note === null) return
    } else if (!window.confirm(`${r.staff ? `${r.staff.name} さんの` : ''}${dayLabel(r.work_date)} の修正申請を${action === 'approve' ? '承認して勤務の時刻を直し' : '取り下げ'}ます。よろしいですか？`)) return
    setBusy(r.id)
    setError('')
    try {
      await api('/api/works/punch-requests/decide', { method: 'POST', body: { id: r.id, action, note } })
      onChanged?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy('')
    }
  }
  if (!items?.length) return <div className="ui-empty">修正申請はありません</div>
  return (
    <>
      {error && <div className="works-error">{error}</div>}
      <div className="works-leave-reqs">
        {items.map((r) => (
          <div key={r.id} className="ui-card">
            <div className="works-leave-req-head">
              <span className={`ui-badge ${BADGE[r.status]}`}>{STATUS[r.status]}</span>
              {admin && r.staff && <strong>{r.staff.name}</strong>}
              {admin && r.staff && <span className="works-muted">{r.staff.code}</span>}
              <span>{dayLabel(r.work_date)}</span>
              <span className="works-muted" style={{ marginLeft: 'auto' }}>申請 {new Date(r.applied_at).toLocaleDateString('ja-JP')}</span>
            </div>
            <div>
              {r.start_time && <>出勤 <strong>{r.shift?.actual_start || '（なし）'} → {r.start_time}</strong>　</>}
              {r.end_time && <>退勤 <strong>{r.shift?.actual_end || '（なし）'} → {r.end_time}</strong></>}
              {r.shift && <span className="works-muted">　予定 {r.shift.plan_start}〜{r.shift.plan_end}</span>}
            </div>
            <div className="works-muted">理由: {r.reason}</div>
            {r.decision_note && <div className="works-muted">{STATUS[r.status]}の理由: {r.decision_note}</div>}
            <div className="works-row-actions" style={{ marginBottom: 0 }}>
              {admin && r.status === 'pending' && (
                <>
                  <button type="button" className="btn-primary works-btn-accent" disabled={busy === r.id} onClick={() => act(r, 'approve')}>承認</button>
                  <button type="button" className="btn-plain" disabled={busy === r.id} onClick={() => act(r, 'reject')}>却下</button>
                </>
              )}
              {!admin && r.status === 'pending' && (
                <button type="button" className="btn-plain" disabled={busy === r.id} onClick={() => act(r, 'cancel')}>取り下げる</button>
              )}
              {onOpen && <button type="button" className="btn-plain" onClick={() => onOpen(r)}>この日を開く</button>}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
