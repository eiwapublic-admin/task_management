// カレンダー（Phase 2。docs/eworks-plan.md 10-3）
//   本人: 自分の月の予定
//   管理者: スタッフを切り替えて同じ月表示／「全員」でスタッフ × 日の表。予定の作成・手での追加と変更
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Modal from '../components/Modal.jsx'
import { api, getUser, WEEKDAYS } from '../lib/api.js'
import { addMonths, dow, hoursLabel, monthRange, todayJst } from '../../../worker/lib/works/time.js'

function monthLabel(ym) {
  const [y, m] = ym.split('-')
  return `${y}年${Number(m)}月`
}

export default function Calendar() {
  const me = getUser()
  const isAdmin = !!me?.works_admin
  // 勤務表一覧から開いたときは ?month=YYYY-MM&staff=<id> で月とスタッフを受け取る
  const [params] = useSearchParams()
  const [month, setMonth] = useState(/^\d{4}-\d{2}$/.test(params.get('month') || '') ? params.get('month') : todayJst().slice(0, 7))
  const [staffId, setStaffId] = useState((isAdmin && params.get('staff')) || me?.staff?.id || (isAdmin ? 'all' : ''))
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [day, setDay] = useState(null)
  const [sites, setSites] = useState([])
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    const q = new URLSearchParams({ month })
    if (isAdmin && staffId) q.set('staff_id', staffId)
    api(`/api/works/shifts?${q}`)
      .then((d) => {
        setData(d)
        setError('')
      })
      .catch((e) => setError(e.message))
  }, [month, staffId, isAdmin])
  useEffect(() => {
    load()
  }, [load])
  useEffect(() => {
    if (isAdmin) api('/api/works/sites').then((d) => setSites(d.items.filter((s) => s.active))).catch(() => {})
  }, [isAdmin])

  const staffList = data?.staff || []
  const idx = staffList.findIndex((s) => s.id === staffId)
  const current = staffList[idx]
  const moveStaff = (n) => {
    if (!staffList.length) return
    const i = idx < 0 ? 0 : (idx + n + staffList.length) % staffList.length
    setStaffId(staffList[i].id)
  }

  const generate = async (onlyThis) => {
    const who = onlyThis ? `${current.code} ${current.name} さん` : '在籍の全員'
    if (!window.confirm(`${monthLabel(month)}の予定を、勤務体系から作り直します（${who}）。\n手で追加・変更した日はそのまま残ります。よろしいですか？`)) return
    setBusy(true)
    try {
      const r = await api('/api/works/shifts/generate', { method: 'POST', body: { month, staff_id: onlyThis ? staffId : undefined } })
      setResult(r)
      load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h1 className="works-title">カレンダー</h1>
      <div className="works-row-actions">
        <button type="button" className="btn-plain" onClick={() => setMonth(addMonths(month, -1))} aria-label="前の月">‹</button>
        <strong className="works-month">{monthLabel(month)}</strong>
        <button type="button" className="btn-plain" onClick={() => setMonth(addMonths(month, 1))} aria-label="次の月">›</button>
        <button type="button" className="btn-plain" onClick={() => setMonth(todayJst().slice(0, 7))}>今月</button>
        {isAdmin && (
          <>
            <span className="works-sep" />
            <button type="button" className="btn-plain" onClick={() => moveStaff(-1)} disabled={staffId === 'all'} aria-label="前のスタッフ">‹</button>
            <select className="ui-select works-staff-select" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
              <option value="all">全員を表で表示</option>
              {staffList.map((s) => (
                <option key={s.id} value={s.id}>{s.code} {s.name}{s.status === 'leave' ? '（休職）' : ''}</option>
              ))}
            </select>
            <button type="button" className="btn-plain" onClick={() => moveStaff(1)} disabled={staffId === 'all'} aria-label="次のスタッフ">›</button>
          </>
        )}
      </div>
      {isAdmin && (
        <div className="works-row-actions">
          <button type="button" className="btn-primary works-btn-accent" disabled={busy} onClick={() => generate(false)}>
            {busy ? '作成中…' : `${monthLabel(month)}の予定を作成（全員）`}
          </button>
          {current && (
            <button type="button" className="btn-plain" disabled={busy} onClick={() => generate(true)}>このスタッフだけ作り直す</button>
          )}
          <span className="ui-note" style={{ margin: 0 }}>
            翌月分は毎月 設定の日に自動で作ります{data?.last_auto_month ? `（最後に自動作成: ${monthLabel(data.last_auto_month)}分）` : ''}
          </span>
        </div>
      )}
      {error && <p className="works-error">{error}</p>}
      {!isAdmin && !me?.staff && <p className="works-muted">スタッフ情報が紐づいていません。管理者にお問い合わせください。</p>}
      {data && staffId === 'all' && <AllTable data={data} month={month} onPick={(id) => setStaffId(id)} />}
      {data && staffId !== 'all' && staffId && (
        <MonthGrid data={data} month={month} onDay={(d) => setDay(d)} />
      )}
      {day && (
        <DayModal
          date={day}
          data={data}
          staff={isAdmin ? current || null : null}
          staffId={staffId}
          sites={sites}
          editable={isAdmin}
          onClose={() => setDay(null)}
          onSaved={() => load()}
        />
      )}
      {result && <ResultModal result={result} onClose={() => setResult(null)} />}
    </>
  )
}

function useDays(month) {
  return useMemo(() => {
    const { days } = monthRange(month)
    return Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)
  }, [month])
}

function dayClass(date, data) {
  const w = dow(date)
  if (data.holidays[date] || w === 0) return 'is-holiday'
  if (data.company_holidays[date]) return 'is-company'
  if (w === 6) return 'is-sat'
  return ''
}

function MonthGrid({ data, month, onDay }) {
  const days = useDays(month)
  const today = todayJst()
  const byDate = useMemo(() => {
    const m = {}
    for (const s of data.items) (m[s.work_date] ||= []).push(s)
    return m
  }, [data])
  const total = data.items.reduce((a, s) => a + s.minutes, 0)
  const workDays = Object.keys(byDate).length
  const lead = dow(days[0])
  return (
    <>
      <div className="works-cal-summary">
        予定 <strong>{workDays}</strong> 日・<strong>{hoursLabel(total)}</strong> 時間
      </div>
      <div className="works-cal">
        {WEEKDAYS.map((w, i) => (
          <div key={w} className={`works-cal-head ${i === 0 ? 'is-holiday' : i === 6 ? 'is-sat' : ''}`}>{w}</div>
        ))}
        {Array.from({ length: lead }, (_, i) => <div key={`b${i}`} className="works-cal-blank" />)}
        {days.map((d) => (
          <button type="button" key={d} className={`works-cal-day ${dayClass(d, data)} ${d === today ? 'is-today' : ''}`} onClick={() => onDay(d)}>
            <span className="works-cal-date">{Number(d.slice(8))}</span>
            {(data.holidays[d] || data.company_holidays[d]) && (
              <span className="works-cal-hname">{data.holidays[d] || data.company_holidays[d]}</span>
            )}
            {(byDate[d] || []).map((s) => (
              <span key={s.id} className={`works-cal-shift ${s.source === 'manual' ? 'is-manual' : ''}`}>
                {s.plan_start.replace(/^0/, '')}<span className="works-cal-end">–{s.plan_end.replace(/^0/, '')}</span>
                {s.site && <span className="works-cal-site">{s.site.name}</span>}
              </span>
            ))}
          </button>
        ))}
      </div>
      <p className="ui-note">紫の線のある予定は、管理者が手で追加・変更したものです（作り直しても残ります）。</p>
    </>
  )
}

function AllTable({ data, month, onPick }) {
  const days = useDays(month)
  const map = useMemo(() => {
    const m = {}
    for (const s of data.items) ((m[s.staff_id] ||= {})[s.work_date] ||= []).push(s)
    return m
  }, [data])
  return (
    <div className="ui-table-wrap works-all">
      <table className="ui-table">
        <thead>
          <tr>
            <th className="works-all-name">スタッフ</th>
            {days.map((d) => (
              <th key={d} className={dayClass(d, data)}>
                {Number(d.slice(8))}
                <br />
                {WEEKDAYS[dow(d)]}
              </th>
            ))}
            <th>計</th>
          </tr>
        </thead>
        <tbody>
          {(data.staff || []).map((st) => {
            const row = map[st.id] || {}
            const total = Object.values(row).flat().reduce((a, s) => a + s.minutes, 0)
            return (
              <tr key={st.id}>
                <td className="works-all-name">
                  <button type="button" className="works-linklike" onClick={() => onPick(st.id)}>{st.code} {st.name}</button>
                </td>
                {days.map((d) => (
                  <td key={d} className={dayClass(d, data)}>
                    {(row[d] || []).map((s) => (
                      <div key={s.id} className={s.source === 'manual' ? 'works-all-manual' : ''}>{s.plan_start.replace(/^0/, '')}</div>
                    ))}
                  </td>
                ))}
                <td>{total ? hoursLabel(total) : ''}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function DayModal({ date, data, staff, staffId, sites, editable, onClose, onSaved }) {
  const shifts = data.items.filter((s) => s.work_date === date)
  const [edit, setEdit] = useState(null)
  const [error, setError] = useState('')
  const title = `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日（${WEEKDAYS[dow(date)]}）${staff ? ` ${staff.name}` : ''}`

  const save = async () => {
    setError('')
    try {
      if (edit.id) await api('/api/works/shifts', { method: 'PATCH', body: edit })
      else await api('/api/works/shifts', { method: 'POST', body: { ...edit, staff_id: staffId, work_date: date } })
      setEdit(null)
      onSaved()
    } catch (e) {
      setError(e.message)
    }
  }
  const remove = async (s) => {
    const msg = s.source === 'auto' ? 'この予定を削除します。\n勤務体系から自動で作った予定なので、「作り直す」と元に戻ります。よろしいですか？' : 'この予定を削除します。よろしいですか？'
    if (!window.confirm(msg)) return
    try {
      await api(`/api/works/shifts?id=${s.id}`, { method: 'DELETE' })
      onSaved()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      {(data.holidays[date] || data.company_holidays[date]) && (
        <p className="works-error" style={{ margin: 0 }}>{data.holidays[date] || data.company_holidays[date]}</p>
      )}
      {shifts.length === 0 && !edit && <p className="works-muted" style={{ margin: 0 }}>予定はありません。</p>}
      {!edit && shifts.map((s) => (
        <div key={s.id} className="ui-card">
          <div className="ui-card-title">
            {s.plan_start}〜{s.plan_end}
            <span className="works-muted" style={{ fontWeight: 400 }}>　{hoursLabel(s.minutes)} 時間{s.break_minutes ? `（休憩 ${s.break_minutes} 分）` : ''}</span>
          </div>
          <div>{s.site ? `${s.site.code} ${s.site.name}` : <span className="works-muted">現場の指定なし</span>}</div>
          {s.note && <div className="works-muted">{s.note}</div>}
          {s.warn_no_break && <div className="ui-note is-danger">6 時間を超える勤務で、休憩が 45 分未満です</div>}
          <div className="works-muted" style={{ fontSize: 'var(--fs-xs)' }}>{s.source === 'manual' ? '手で追加・変更した予定' : '勤務体系から自動作成'}</div>
          {editable && (
            <div className="works-row-actions" style={{ marginTop: 8, marginBottom: 0 }}>
              <button type="button" className="btn-plain" onClick={() => setEdit({ id: s.id, plan_start: s.plan_start, plan_end: s.plan_end, site_id: s.site_id || '', note: s.note || '' })}>変更</button>
              <button type="button" className="btn-plain" onClick={() => remove(s)}>削除</button>
            </div>
          )}
        </div>
      ))}
      {editable && !edit && (
        <div>
          <button type="button" className="btn-plain" onClick={() => setEdit({ plan_start: shifts[0]?.plan_start || '09:00', plan_end: shifts[0]?.plan_end || '17:00', site_id: shifts[0]?.site_id || '', note: '' })}>
            ＋ この日に予定を追加
          </button>
        </div>
      )}
      {edit && (
        <>
          <div className="ui-field-row">
            <label className="ui-field"><span>開始</span><input className="ui-input" type="time" value={edit.plan_start} onChange={(e) => setEdit({ ...edit, plan_start: e.target.value })} /></label>
            <label className="ui-field"><span>終了</span><input className="ui-input" type="time" value={edit.plan_end} onChange={(e) => setEdit({ ...edit, plan_end: e.target.value })} /></label>
          </div>
          <label className="ui-field">
            <span>現場</span>
            <select className="ui-select" value={edit.site_id} onChange={(e) => setEdit({ ...edit, site_id: e.target.value })}>
              <option value="">（指定なし）</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}
            </select>
          </label>
          <label className="ui-field"><span>メモ（代勤・時間変更の理由など）</span><input className="ui-input" value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></label>
          <div className="works-row-actions">
            <button type="button" className="btn-primary works-btn-accent" onClick={save}>保存</button>
            <button type="button" className="btn-plain" onClick={() => setEdit(null)}>やめる</button>
          </div>
        </>
      )}
      {error && <div className="works-error">{error}</div>}
    </Modal>
  )
}

export function ResultModal({ result, onClose }) {
  return (
    <Modal title={`${monthLabel(result.month)}の予定を作成しました`} onClose={onClose}>
      <p style={{ margin: 0 }}>作成: <strong>{result.created.length}</strong> 名（{result.created.reduce((a, c) => a + (c.days || 0), 0)} 件）</p>
      {result.skipped.length > 0 && (
        <>
          <p style={{ margin: 0 }}>予定を作らなかったスタッフ: {result.skipped.length} 名</p>
          <div className="ui-table-wrap">
            <table className="ui-table">
              <tbody>
                {result.skipped.map((s) => (
                  <tr key={s.code}><td>{s.code} {s.name}</td><td>{s.reason}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  )
}
