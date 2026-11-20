// 出勤・退勤の時刻の直接入力（入力方法が「本人」の本人と、管理者の代理入力。2026-11-20）。
//   「予定通り」で予定の時刻を入れて保存する。時刻は入力したとおりに記録する（丸めない）
import { useState } from 'react'
import { api } from '../lib/api.js'

export default function ActualEditor({ shift, onSaved, compact = false }) {
  const [start, setStart] = useState(shift.actual_start || '')
  const [end, setEnd] = useState(shift.actual_end || '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const changed = start !== (shift.actual_start || '') || end !== (shift.actual_end || '')

  const run = async (fn, done) => {
    setBusy(true)
    setError('')
    setMsg('')
    try {
      await fn()
      setMsg(done)
      onSaved?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  const save = () => run(() => api('/api/works/actuals', { method: 'POST', body: { shift_id: shift.id, start, end } }), '保存しました')
  const asPlanned = () => {
    setStart(shift.plan_start)
    setEnd(shift.plan_end)
    return run(() => api('/api/works/actuals/plan', { method: 'POST', body: { shift_id: shift.id } }), '予定通りに入力しました')
  }

  return (
    <div className={`works-actual-edit ${compact ? 'is-compact' : ''}`}>
      <div className="works-actual-row">
        <label>
          <span>出勤</span>
          <input className="ui-input" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <span className="works-actual-sep">〜</span>
        <label>
          <span>退勤</span>
          <input className="ui-input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
      </div>
      <div className="works-row-actions" style={{ marginBottom: 0 }}>
        <button type="button" className="btn-primary works-btn-accent" disabled={busy || !changed} onClick={save}>保存</button>
        <button type="button" className="btn-plain" disabled={busy} onClick={asPlanned}>予定通り（{shift.plan_start}〜{shift.plan_end}）</button>
        {msg && <span className="works-muted">{msg}</span>}
      </div>
      {error && <div className="works-error">{error}</div>}
    </div>
  )
}
