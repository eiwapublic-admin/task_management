// 出勤・退勤の時刻の直接入力（入力方法が「本人」の本人と、管理者の代理入力。2026-11-20）。
//   「←予定通り」で予定の時刻を入れて保存する。時刻は入力したとおりに記録する（丸めない）
//   2026-11-25: 時刻は日報と同じく数字 3〜4 桁で入力（900 → 9:00）。管理者がほかのスタッフの分を入れるときは
//   「代理入力理由」の欄を常に出す（打刻の記録に「代理入力（理由）」として残る）。保存は枠の右下
import { useState } from 'react'
import { api } from '../lib/api.js'
import TimeInput from '../../components/TimeInput.jsx'

export default function ActualEditor({ shift, onSaved, compact = false, proxy = false }) {
  const [start, setStart] = useState(shift.actual_start || '')
  const [end, setEnd] = useState(shift.actual_end || '')
  const [reason, setReason] = useState('')
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
      setReason('')
      onSaved?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  const note = proxy ? reason.trim() : undefined
  // 保存は押せるままにする（時刻の欄は欄を離れたときに確定するので、押せないと入力直後に押しても反応しない）
  const save = () => (changed ? run(() => api('/api/works/actuals', { method: 'POST', body: { shift_id: shift.id, start, end, note } }), '保存しました') : setMsg('変更はありません'))
  const asPlanned = () => {
    setStart(shift.plan_start)
    setEnd(shift.plan_end)
    return run(() => api('/api/works/actuals/plan', { method: 'POST', body: { shift_id: shift.id, note } }), '予定通りに入力しました')
  }

  return (
    <div className={`works-actual-edit ${compact ? 'is-compact' : ''}`}>
      <div className="works-actual-row">
        <label>
          <span>出勤</span>
          <TimeInput className="ui-input" value={start} onChange={setStart} aria-label="出勤の時刻" />
        </label>
        <span className="works-actual-sep">〜</span>
        <label>
          <span>退勤</span>
          <TimeInput className="ui-input" value={end} onChange={setEnd} aria-label="退勤の時刻" />
        </label>
        <button type="button" className="btn-plain works-asplan" disabled={busy} onClick={asPlanned} title={`予定の時刻（${shift.plan_start}〜${shift.plan_end}）を入れて保存します`}>
          ←予定通り
        </button>
      </div>
      {proxy && (
        <label className="ui-field works-actual-reason">
          <span>代理入力理由（スマートフォンなし・打刻忘れなど）</span>
          <input className="ui-input" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
        </label>
      )}
      <div className="works-actual-foot">
        {msg && <span className="works-muted">{msg}</span>}
        <button type="button" className="btn-primary works-btn-accent" disabled={busy} onClick={save}>保存</button>
      </div>
      {error && <div className="works-error">{error}</div>}
    </div>
  )
}
