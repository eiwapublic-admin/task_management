// 休暇の申請の一覧（本人用・管理者用で共通）。状態・日付・事由と、印刷・取り下げ・承認・却下のボタン
import { useState } from 'react'
import { api } from '../lib/api.js'
import { rangesLabel } from '../lib/leave.js'

const STATUS = { pending: '承認待ち', approved: '承認済み', rejected: '却下', cancelled: '取り下げ' }
const BADGE = { pending: 'is-warn', approved: 'is-ok', rejected: 'is-danger', cancelled: '' }

export default function LeaveRequestList({ items, admin = false, onChanged, onPrint }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const act = async (r, action) => {
    const label = { approve: '承認', reject: '却下', cancel: r.status === 'approved' ? '取り消し（取得日も消えます）' : '取り下げ' }[action]
    let note = ''
    if (action === 'reject') {
      note = window.prompt('却下の理由（本人に表示されます。空欄でも可）', '')
      if (note === null) return
    } else if (!window.confirm(`${r.staff ? `${r.staff.code} ${r.staff.name} さんの` : ''}${rangesLabel(r.dates)} の申請を${label}します。よろしいですか？`)) return
    setError('')
    setBusy(r.id)
    try {
      await api('/api/works/leave/requests/decide', { method: 'POST', body: { id: r.id, action, note } })
      onChanged()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy('')
    }
  }
  if (!items?.length) return <div className="ui-empty">申請はありません</div>
  return (
    <>
      {error && <div className="works-error">{error}</div>}
      <div className="works-leave-reqs">
        {items.map((r) => (
          <div key={r.id} className={`ui-card works-leave-req is-${r.status}`}>
            <div className="works-leave-req-head">
              <span className={`ui-badge ${BADGE[r.status]}`}>{STATUS[r.status]}</span>
              {admin && r.staff && <strong>{r.staff.code} {r.staff.name}</strong>}
              <span>{r.kind === 'special' ? '特別休暇' : '有給休暇'} {r.dates.length} 日</span>
              {r.proxy && <span className="works-muted">紙の申請書から入力</span>}
              <span className="works-muted" style={{ marginLeft: 'auto' }}>申請 {new Date(r.applied_at).toLocaleDateString('ja-JP')}</span>
            </div>
            <div className="works-leave-req-dates">{rangesLabel(r.dates)}</div>
            {r.reason && <div className="works-muted">事由: {r.reason}</div>}
            {r.status !== 'pending' && r.decided_at && (
              <div className="works-muted">
                {STATUS[r.status]} {new Date(r.decided_at).toLocaleDateString('ja-JP')}
                {r.decided_by_name ? `（${r.decided_by_name}）` : ''}
                {r.decision_note && !r.proxy ? `　${r.decision_note}` : ''}
              </div>
            )}
            <div className="works-row-actions">
              <button type="button" className="btn-plain" onClick={() => onPrint(r)}>申請書を印刷</button>
              {admin && r.status === 'pending' && (
                <>
                  <button type="button" className="btn-primary works-btn-accent" disabled={busy === r.id} onClick={() => act(r, 'approve')}>承認</button>
                  <button type="button" className="btn-plain" disabled={busy === r.id} onClick={() => act(r, 'reject')}>却下</button>
                </>
              )}
              {r.status === 'pending' && !admin && (
                <button type="button" className="btn-plain" disabled={busy === r.id} onClick={() => act(r, 'cancel')}>取り下げる</button>
              )}
              {admin && r.status === 'approved' && (
                <button type="button" className="btn-plain" disabled={busy === r.id} onClick={() => act(r, 'cancel')}>取り消す</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
