// 日の画面の「要確認」と「打刻の修正申請」（docs/eworks-plan.md 8-2・6-3）
//   管理者: その日の要確認を確認済みにする（メモつき）・取り消す、修正申請の承認・却下
//   本人: 同じ印を見て、打刻の修正を申請する（入力方法が QR の人。「本人」の人は時刻を直接直せる）
import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { todayJst } from '../../../worker/lib/works/time.js'
import PunchRequestList from './PunchRequestList.jsx'

import { LEVEL_BADGE } from '../lib/alerts.js'

export default function DayAlerts({ date, staffId, shifts, admin, canRequest, onChanged }) {
  const [alerts, setAlerts] = useState(null)
  const [requests, setRequests] = useState([])
  const [form, setForm] = useState(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    if (date > todayJst() || !staffId || staffId === 'all') return
    const q = new URLSearchParams({ from: date, to: date, status: 'all', staff_id: staffId })
    api(`/api/works/alerts?${q}`).then((d) => setAlerts(d.items)).catch((e) => setError(e.message))
    api(`/api/works/punch-requests?${new URLSearchParams({ status: 'all', staff_id: staffId })}`)
      .then((d) => setRequests(d.items.filter((r) => r.work_date === date && (r.status === 'pending' || !admin))))
      .catch(() => {})
  }, [date, staffId, admin])
  useEffect(() => {
    load()
  }, [load])
  if (date > todayJst()) return null
  const changed = () => {
    load()
    onChanged?.()
  }
  const resolve = async (keys, undo = false) => {
    setBusy(true)
    setError('')
    try {
      await api('/api/works/alerts/resolve', { method: 'POST', body: { keys, note, undo } })
      setNote('')
      changed()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  const open = (alerts || []).filter((a) => !a.resolved_at)
  const done = (alerts || []).filter((a) => a.resolved_at)
  const pendingShift = new Set(requests.filter((r) => r.status === 'pending').map((r) => r.shift_id))
  return (
    <div className="works-day-alerts">
      {alerts && alerts.length > 0 && (
        <div className={`ui-card works-alert-card ${open.length ? 'is-open' : ''}`}>
          <div className="ui-card-title">要確認{open.length ? ` ${open.length} 件` : '（確認済み）'}</div>
          {[...open, ...done].map((a) => (
            <div key={a.key} className={`works-alert-line ${a.resolved_at ? 'is-done' : ''}`}>
              <span className={`ui-badge ${a.resolved_at ? '' : LEVEL_BADGE[a.level]}`}>{a.label}</span>
              <span>{a.detail}</span>
              {a.resolved_at && (
                <span className="works-muted">
                  　確認済み {new Date(a.resolved_at).toLocaleDateString('ja-JP')}{a.note ? `（${a.note}）` : ''}
                  {admin && <button type="button" className="btn-plain works-btn-xs" disabled={busy} onClick={() => resolve([a.key], true)}>取り消す</button>}
                </span>
              )}
            </div>
          ))}
          {admin && open.length > 0 && (
            <div className="works-row-actions" style={{ marginBottom: 0, marginTop: 8 }}>
              <input className="ui-input" style={{ flex: 1, minWidth: 160 }} placeholder="確認のメモ（任意）" value={note} onChange={(e) => setNote(e.target.value)} />
              <button type="button" className="btn-primary works-btn-accent" disabled={busy} onClick={() => resolve(open.map((a) => a.key))}>確認済みにする</button>
            </div>
          )}
          {!admin && open.length > 0 && <p className="ui-note" style={{ margin: '6px 0 0' }}>記録がまちがっているときは、下の「打刻の修正を申請」から申請してください。</p>}
        </div>
      )}
      {requests.length > 0 && (
        <div>
          <strong>打刻の修正申請</strong>
          <PunchRequestList items={requests} admin={admin} onChanged={changed} />
        </div>
      )}
      {canRequest && !form && shifts.filter((s) => !pendingShift.has(s.id)).map((s) => (
        <button key={s.id} type="button" className="btn-plain" onClick={() => setForm({ shift_id: s.id, start: s.actual_start || s.plan_start, end: s.actual_end || s.plan_end, reason: '', _label: `${s.plan_start}〜${s.plan_end}` })}>
          打刻の修正を申請{shifts.length > 1 ? `（${s.plan_start}〜${s.plan_end}）` : ''}
        </button>
      ))}
      {form && (
        <div className="ui-card">
          <div className="ui-card-title">打刻の修正を申請（予定 {form._label}）</div>
          <div className="works-actual-row">
            <label><span>出勤</span><input className="ui-input" type="time" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></label>
            <span className="works-actual-sep">〜</span>
            <label><span>退勤</span><input className="ui-input" type="time" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /></label>
          </div>
          <label className="ui-field"><span>理由（退勤の打刻を忘れた、など）</span><input className="ui-input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
          <p className="ui-note" style={{ margin: 0 }}>実際に出勤・退勤した時刻を入れてください。管理者が承認すると勤務表に入ります。</p>
          <div className="works-row-actions" style={{ marginBottom: 0 }}>
            <button type="button" className="btn-primary works-btn-accent" disabled={busy || !form.reason.trim()} onClick={() => {
              const s = shifts.find((x) => x.id === form.shift_id)
              // 今の記録と同じ時刻は送らない（変えたい方だけ）
              const body = { shift_id: form.shift_id, reason: form.reason, start: form.start && form.start !== s?.actual_start ? form.start : null, end: form.end && form.end !== s?.actual_end ? form.end : null }
              if (!body.start && !body.end) return setError('今の記録と同じ時刻です。直したい時刻を入れてください')
              setForm(null)
              setBusy(true)
              api('/api/works/punch-requests', { method: 'POST', body })
                .then(changed)
                .catch((e) => { setError(e.message); setForm(form) })
                .finally(() => setBusy(false))
            }}>申請する</button>
            <button type="button" className="btn-plain" onClick={() => setForm(null)}>やめる</button>
          </div>
        </div>
      )}
      {error && <div className="works-error">{error}</div>}
    </div>
  )
}
