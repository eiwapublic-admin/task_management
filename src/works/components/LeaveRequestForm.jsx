// 有給休暇・特別休暇の申請フォーム。
//   本人: 申請 → 労務担当の承認待ちになる。
//   管理者（staffList を渡す）: 紙の申請書の代理入力。スタッフを選び、承認済みで登録する。
//   管理者（staff を渡す）: 「スタッフ別」の日の詳細から、そのスタッフの分を承認済みで登録する（date はその日。2026-11-24）
// 期間を選ぶと 1 日ずつ並べ、予定（勤務）のある日に最初から印を付ける（予定がまだ無い月は平日に付ける）
import { useEffect, useMemo, useState } from 'react'
import Modal from './Modal.jsx'
import { api, WEEKDAYS } from '../lib/api.js'
import { todayJst } from '../../../worker/lib/works/time.js'

function daysBetween(from, to) {
  const out = []
  if (!from || !to || to < from) return out
  const d = new Date(`${from}T00:00:00Z`)
  for (let i = 0; i < 62; i++) {
    const s = d.toISOString().slice(0, 10)
    if (s > to) break
    out.push(s)
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}
const dowOf = (d) => new Date(`${d}T00:00:00Z`).getUTCDay()

export default function LeaveRequestForm({ staffList = null, staff = null, date = null, summary = null, onClose, onSaved }) {
  const proxy = !!staffList || !!staff
  const [staffId, setStaffId] = useState(staff?.id || '')
  const [kind, setKind] = useState('paid')
  const [from, setFrom] = useState(date || todayJst())
  const [to, setTo] = useState(date || todayJst())
  const [checked, setChecked] = useState({})
  const [reason, setReason] = useState('')
  const [shiftDays, setShiftDays] = useState(null)
  const [holidays, setHolidays] = useState({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const days = useMemo(() => daysBetween(from, to), [from, to])
  const months = useMemo(() => [...new Set(days.map((d) => d.slice(0, 7)))].join(','), [days])

  // 期間にかかる月の予定と祝日を読み、勤務のある日に印を付ける
  useEffect(() => {
    if (!months || (proxy && !staffId)) {
      setShiftDays(null)
      return
    }
    let alive = true
    Promise.all(
      months.split(',').map((m) => api(`/api/works/shifts?${new URLSearchParams(proxy ? { month: m, staff_id: staffId } : { month: m })}`).catch(() => null))
    ).then((rs) => {
      if (!alive) return
      const set = new Set()
      const hol = {}
      let any = false
      for (const r of rs) {
        if (!r) continue
        if (r.items?.length) any = true
        for (const s of r.items || []) set.add(s.work_date)
        Object.assign(hol, r.holidays || {})
      }
      setHolidays(hol)
      setShiftDays(any ? set : null)
    })
    return () => {
      alive = false
    }
  }, [months, proxy, staffId])

  useEffect(() => {
    const next = {}
    for (const d of days) {
      if (kind === 'special') next[d] = !!holidays[d]
      else if (shiftDays) next[d] = shiftDays.has(d)
      else next[d] = dowOf(d) >= 1 && dowOf(d) <= 5 && !holidays[d]
    }
    setChecked(next)
  }, [days, shiftDays, holidays, kind])

  const picked = days.filter((d) => checked[d])
  const remain = summary?.period ? (kind === 'special' ? summary.period.special_remain : summary.period.remain) : null

  const save = async () => {
    setError('')
    if (proxy && !staffId) return setError('スタッフを選んでください')
    if (!picked.length) return setError('休む日に印を付けてください')
    setBusy(true)
    try {
      const { item } = await api('/api/works/leave/requests', { method: 'POST', body: { kind, dates: picked, reason, ...(proxy ? { staff_id: staffId } : {}) } })
      onSaved(item)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={staff ? `${staff.name} さんの休暇を登録（承認済み）` : proxy ? '紙の申請書を入力（承認済みで登録）' : '休暇を申請する'}
      onClose={onClose}
      size="lg"
      foot={
        <button type="button" className="btn-primary works-btn-accent" disabled={busy} onClick={save}>
          {busy ? '送信中…' : proxy ? `${picked.length} 日を登録する` : `${picked.length} 日を申請する`}
        </button>
      }
    >
      {staffList && !staff && (
        <label className="ui-field">
          <span>スタッフ</span>
          <select className="ui-select" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            <option value="">選んでください</option>
            {staffList.map((s) => <option key={s.staff_id} value={s.staff_id}>{s.code} {s.name}</option>)}
          </select>
        </label>
      )}
      <div className="works-row-actions">
        <label className="works-inline-field">
          <input type="radio" name="lk" checked={kind === 'paid'} onChange={() => setKind('paid')} /> 有給休暇
        </label>
        <label className="works-inline-field">
          <input type="radio" name="lk" checked={kind === 'special'} onChange={() => setKind('special')} /> 特別休暇（祝日・振替休日のみ）
        </label>
      </div>
      <div className="works-row-actions">
        <label className="works-inline-field">
          期間
          <input className="ui-input" type="date" value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value) }} />
        </label>
        〜
        <input className="ui-input" style={{ width: 'auto' }} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
      </div>
      {days.length > 0 && (
        <>
          <div className="ui-label">休む日（{shiftDays ? '勤務の予定がある日' : '平日'}に印を付けています。変えるときは押してください）</div>
          <div className="works-leave-pick">
            {days.map((d) => (
              <label key={d} className={`works-leave-pickday ${checked[d] ? 'is-on' : ''} ${dowOf(d) === 0 || holidays[d] ? 'is-sun' : dowOf(d) === 6 ? 'is-sat' : ''}`}>
                <input type="checkbox" checked={!!checked[d]} onChange={(e) => setChecked({ ...checked, [d]: e.target.checked })} />
                {Number(d.slice(5, 7))}/{Number(d.slice(8))}（{WEEKDAYS[dowOf(d)]}）
                {shiftDays?.has(d) && <small>勤務</small>}
              </label>
            ))}
          </div>
        </>
      )}
      <label className="ui-field">
        <span>事由（任意）</span>
        <textarea className="ui-input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例: 私用のため" />
      </label>
      {remain != null && (
        <p className="ui-note" style={{ margin: 0 }}>
          今の{kind === 'special' ? '特別休暇' : '有給休暇'}の残りは <strong>{remain} 日</strong>です。
          {picked.length > remain && <span className="works-none">　残りより多い日数です。</span>}
        </p>
      )}
      <p className="ui-note" style={{ margin: 0 }}>
        {staff ? '管理者が入力するので、承認済みで取得日に入ります（紙の申請書を受け付けたときもここから入力できます）。' : proxy ? '紙の申請書の内容をそのまま入力してください。登録すると取得日にも入ります。' : '申請すると、労務担当が確認して承認します。承認されると取得日に入ります。'}
      </p>
      {error && <div className="works-error">{error}</div>}
    </Modal>
  )
}
