// カレンダー（Phase 2。docs/eworks-plan.md 10-3）
//   本人: 自分の月の予定
//   管理者（メニュー名「スタッフ別」）: スタッフを切り替えて同じ月表示／「全員」でスタッフ × 日の表。予定の作成・手での追加と変更。
//     2026-11-24: ホーム・休暇を廃止し、管理者自身の勤務入力（自分を選ぶ）・休暇の申請（日の詳細）・有給休暇の残りもここで行う
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Modal, { ModalFoot } from '../components/Modal.jsx'
import ActualEditor from '../components/ActualEditor.jsx'
import { api, getUser, WEEKDAYS } from '../lib/api.js'
import { addMonths, dow, hoursLabel, monthRange, todayJst } from '../../../worker/lib/works/time.js'
import KeyCell from '../components/KeyCell.jsx'
import DayAlerts from '../components/DayAlerts.jsx'
import LeaveRequestForm from '../components/LeaveRequestForm.jsx'
import StaffLeavePanel from '../components/StaffLeavePanel.jsx'
import useAttendanceSheetPdf from '../components/useAttendanceSheetPdf.jsx'

const METHOD_LABEL = { qr: 'QR', self: '本人が入力', proxy: '管理者が代理入力' }

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
  const [leaveForm, setLeaveForm] = useState(null)
  const [leaveSummary, setLeaveSummary] = useState(null)
  const [leaveVersion, setLeaveVersion] = useState(0)
  const sheetPdf = useAttendanceSheetPdf()

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
  // この月の要確認（カレンダーの日に印を出す。本人にも同じ印。8-2）
  const [alerts, setAlerts] = useState({})
  const loadAlerts = useCallback(() => {
    if (!staffId || staffId === 'all') return setAlerts({})
    const { from, to } = monthRange(month)
    if (from > todayJst()) return setAlerts({})
    api(`/api/works/alerts?${new URLSearchParams({ from, to, staff_id: staffId, status: 'open' })}`)
      .then((d) => {
        const m = {}
        for (const a of d.items) (m[a.work_date] ||= []).push(a)
        setAlerts(m)
      })
      .catch(() => setAlerts({}))
  }, [month, staffId])
  useEffect(() => {
    loadAlerts()
  }, [loadAlerts])
  useEffect(() => {
    if (isAdmin) api('/api/works/sites').then((d) => setSites(d.items.filter((s) => s.active))).catch(() => {})
  }, [isAdmin])

  const staffList = data?.staff || []
  const idx = staffList.findIndex((s) => s.id === staffId)
  const current = staffList[idx]

  // 実績を入力できるか（管理者、または入力方法が「本人」の本人）
  const selfInput = !isAdmin && me?.staff?.punch_method === 'self'
  const canActual = isAdmin || selfInput
  const fillMonth = async () => {
    const who = isAdmin ? `${current.code} ${current.name} さんの` : ''
    if (!window.confirm(`${monthLabel(month)}の${who}今日までの勤務で、出勤・退勤が入っていない日に予定通りの時刻を入れます。よろしいですか？`)) return
    setBusy(true)
    try {
      const r = await api('/api/works/actuals/plan', { method: 'POST', body: { staff_id: staffId, month } })
      window.alert(`${r.count} 日分を予定通りに入力しました`)
      load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const generate = async (onlyThis) => {
    const who = onlyThis ? `${current.code} ${current.name} さん` : '在籍の全員'
    if (!window.confirm(`${monthLabel(month)}の予定を、勤務体系から作り直します（${who}）。\n手で追加・変更した日と、出勤・退勤の記録がある日はそのまま残ります。よろしいですか？`)) return
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
      <div className="works-sticky">
        <h1 className="works-title">{isAdmin ? 'スタッフ別' : 'カレンダー'}</h1>
        <div className="works-row-actions">
          <button type="button" className="works-arrow" onClick={() => setMonth(addMonths(month, -1))} aria-label="前の月">‹</button>
          <strong className="works-month">{monthLabel(month)}</strong>
          <button type="button" className="works-arrow" onClick={() => setMonth(addMonths(month, 1))} aria-label="次の月">›</button>
          <button type="button" className="btn-plain" onClick={() => setMonth(todayJst().slice(0, 7))}>今月</button>
          {isAdmin && (
            <>
              <span className="works-sep" />
              <select className="ui-select works-staff-select" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
                <option value="all">全員を表で表示</option>
                {staffList.map((s) => (
                  <option key={s.id} value={s.id}>{s.code} {s.name}{s.status === 'leave' ? '（休職）' : ''}{s.id === me?.staff?.id ? '（自分）' : ''}</option>
                ))}
              </select>
              {current && (
                <>
                  <button type="button" className="btn-plain" disabled={busy} onClick={() => generate(true)}>{busy ? '作成中…' : '予定を再作成'}</button>
                  <button type="button" className="btn-plain" disabled={busy || sheetPdf.busy} onClick={() => sheetPdf.open(month, current.id)}>出勤簿を印刷</button>
                </>
              )}
            </>
          )}
        </div>
        {((isAdmin && current) || selfInput) && (
          <div className="works-row-actions">
            {isAdmin && current && <span className="works-muted">入力方法: {METHOD_LABEL[current.punch_method || 'qr']}</span>}
            <button type="button" className="btn-plain" disabled={busy} onClick={fillMonth}>この月の実績を予定通りに入力</button>
          </div>
        )}
      </div>
      {error && <p className="works-error">{error}</p>}
      {sheetPdf.error && <p className="works-error">{sheetPdf.error}</p>}
      {!isAdmin && !me?.staff && <p className="works-muted">スタッフ情報が紐づいていません。管理者にお問い合わせください。</p>}
      {data && staffId === 'all' && <AllTable data={data} month={month} onPick={(id) => setStaffId(id)} />}
      {data && staffId !== 'all' && staffId && (
        <MonthGrid data={data} month={month} alerts={alerts} onDay={(d) => setDay(d)} />
      )}
      {isAdmin && current && <StaffLeavePanel staff={current} version={leaveVersion} onLoaded={setLeaveSummary} />}
      {day && (
        <DayModal
          date={day}
          data={data}
          staff={isAdmin ? current || null : null}
          staffId={staffId}
          sites={sites}
          editable={isAdmin}
          actualEditable={canActual}
          canRequest={!isAdmin && (me?.staff?.punch_method || 'qr') === 'qr'}
          onLeave={isAdmin && current ? (d) => {
            setDay(null)
            setLeaveForm({ date: d })
          } : null}
          onClose={() => setDay(null)}
          onSaved={() => {
            load()
            loadAlerts()
          }}
        />
      )}
      {result && <ResultModal result={result} onClose={() => setResult(null)} />}
      {sheetPdf.ui}
      {leaveForm && current && (
        <LeaveRequestForm
          date={leaveForm.date}
          // 自分の分は今までどおり申請（もう一人の管理者が承認）。ほかのスタッフの分は管理者の入力なので承認済みで登録
          staff={current.id === me?.staff?.id ? null : current}
          summary={leaveSummary}
          onClose={() => setLeaveForm(null)}
          onSaved={() => {
            setLeaveForm(null)
            setLeaveVersion((v) => v + 1)
          }}
        />
      )}
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

function MonthGrid({ data, month, alerts = {}, onDay }) {
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
            {alerts[d]?.length > 0 && (
              <span className={`works-cal-alert ${alerts[d].some((a) => a.level === 'high') ? 'is-high' : ''}`} title={alerts[d].map((a) => a.label).join('・')}>
                {alerts[d].length === 1 ? alerts[d][0].label : `要確認 ${alerts[d].length}`}
              </span>
            )}
            {(byDate[d] || []).map((s) => (
              <span key={s.id} className={`works-cal-shift ${s.source === 'manual' ? 'is-manual' : ''}`}>
                {s.plan_start.replace(/^0/, '')}<span className="works-cal-end">–{s.plan_end.replace(/^0/, '')}</span>
                {s.telework ? <span className="works-cal-site works-tw-text">テレワーク</span> : s.site && <span className="works-cal-site">{s.site.name}</span>}
                {recentlyChanged(s, today) && <span className="works-cal-changed">変更あり</span>}
                {s.actual_start && (
                  <span className="works-cal-actual">
                    記録 <Diff value={s.actual_start} plan={s.plan_start} short />
                    <span className="works-cal-end">–{s.actual_end && <Diff value={s.actual_end} plan={s.plan_end} short />}</span>
                  </span>
                )}
              </span>
            ))}
          </button>
        ))}
      </div>
      <p className="ui-note">紫の線のある予定は、管理者が手で追加・変更したものです（作り直しても残ります）。「変更あり」は、この 2 週間に管理者が変えた今日以降の予定です。赤・橙の印は要確認（日を押すと内容を見られます）。</p>
    </>
  )
}

// 管理者がこの 2 週間に変えた、今日以降の予定（13-1 の 10）
function recentlyChanged(s, today) {
  if (!s.plan_changed_at || s.work_date < today) return false
  return Date.now() - new Date(s.plan_changed_at).getTime() < 14 * 24 * 3600e3
}

// 実績（記録）の時刻。予定と違うときは赤の太字（2026-11-19 依頼元の要望）
function Diff({ value, plan, short = false }) {
  const text = short ? value.replace(/^0/, '') : value
  return value !== plan ? <span className="works-diff">{text}</span> : text
}

function AllTable({ data, month, onPick }) {
  const days = useDays(month)
  const map = useMemo(() => {
    const m = {}
    for (const s of data.items) ((m[s.staff_id] ||= {})[s.work_date] ||= []).push(s)
    return m
  }, [data])
  return (
    <div className="ui-table-wrap works-all works-scroll">
      <table className="ui-table">
        <thead>
          <tr>
            <th className="works-key">スタッフ</th>
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
                <td className="works-key">
                  <button type="button" className="works-linklike works-key-btn" onClick={() => onPick(st.id)}>
                    <strong className="works-key-name">{st.name}</strong>
                    <span className="works-key-code">{st.code}</span>
                  </button>
                </td>
                {days.map((d) => (
                  <td key={d} className={dayClass(d, data)}>
                    {(row[d] || []).map((s) => (
                      <div key={s.id} className={`${s.source === 'manual' ? 'works-all-manual' : ''} ${s.actual_start && s.actual_end ? 'works-all-done' : s.actual_start ? 'works-all-working' : ''}`} title={s.actual_start ? `記録 ${s.actual_start}〜${s.actual_end || ''}` : undefined}>{s.plan_start.replace(/^0/, '')}</div>
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

export function DayModal({ date, data, staff, staffId, sites, editable, actualEditable, canRequest = false, onLeave = null, onClose, onSaved }) {
  const shifts = data.items.filter((s) => s.work_date === date)
  const [edit, setEdit] = useState(null)
  const [error, setError] = useState('')
  const title = `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日（${WEEKDAYS[dow(date)]}）${staff ? ` ${staff.name}` : ''}`

  const save = async () => {
    setError('')
    try {
      if (edit.id) await api('/api/works/shifts', { method: 'PATCH', body: edit })
      else await api('/api/works/shifts', { method: 'POST', body: { ...edit, staff_id: staffId, work_date: date } })
      onSaved()
      onClose()
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
      {staffId && staffId !== 'all' && !edit && (
        <DayAlerts date={date} staffId={staffId} shifts={shifts} admin={editable} canRequest={canRequest} onChanged={onSaved} />
      )}
      {shifts.length === 0 && !edit && <p className="works-muted" style={{ margin: 0 }}>予定はありません。</p>}
      {!edit && shifts.map((s) => (
        <div key={s.id} className="ui-card">
          <div className="ui-card-title">
            {s.plan_start}〜{s.plan_end}
            <span className="works-muted" style={{ fontWeight: 400 }}>　{hoursLabel(s.minutes)} 時間{s.break_minutes ? `（休憩 ${s.break_minutes} 分）` : ''}</span>
          </div>
          <div>
            {s.telework && <span className="works-tw-badge" style={{ marginRight: 6 }}>テレワーク</span>}
            {s.site ? `${s.site.code} ${s.site.name}` : !s.telework && <span className="works-muted">現場の指定なし</span>}
          </div>
          {s.note && <div className="works-muted">{s.note}</div>}
          <div>
            {s.actual_start ? (
              <span className="works-actual">
                記録 <Diff value={s.actual_start} plan={s.plan_start} />〜{s.actual_end ? <Diff value={s.actual_end} plan={s.plan_end} /> : '（退勤なし）'}
              </span>
            ) : date <= todayJst() ? (
              <span className="works-muted">出勤・退勤の記録はまだありません</span>
            ) : null}
          </div>
          {actualEditable && (editable || date <= todayJst()) && (
            <div className="works-actual-box">
              <div className="works-muted" style={{ fontSize: 'var(--fs-xs)' }}>出勤・退勤の時刻{editable && staff ? '（代理入力）' : ''}</div>
              <ActualEditor shift={s} onSaved={onSaved} compact />
            </div>
          )}
          {s.warn_no_break && <div className="ui-note is-danger">6 時間を超える勤務で、休憩が 45 分未満です</div>}
          <div className="works-muted" style={{ fontSize: 'var(--fs-xs)' }}>{s.source === 'manual' ? '手で追加・変更した予定' : '勤務体系から自動作成'}</div>
          {editable && (
            <div className="works-row-actions" style={{ marginTop: 8, marginBottom: 0 }}>
              <button type="button" className="btn-plain" onClick={() => setEdit({ id: s.id, plan_start: s.plan_start, plan_end: s.plan_end, site_id: s.site_id || '', telework: !!s.telework, note: s.note || '' })}>変更</button>
              <button type="button" className="btn-plain" onClick={() => remove(s)}>削除</button>
            </div>
          )}
        </div>
      ))}
      {editable && !edit && (
        <div className="works-row-actions" style={{ marginBottom: 0 }}>
          {onLeave && <button type="button" className="btn-plain" onClick={() => onLeave(date)}>＋ 休暇を申請する</button>}
          <button type="button" className="btn-plain" onClick={() => setEdit({ plan_start: shifts[0]?.plan_start || '09:00', plan_end: shifts[0]?.plan_end || '17:00', site_id: shifts[0]?.site_id || '', telework: !!shifts[0]?.telework, note: '' })}>
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
          <label><input type="checkbox" checked={!!edit.telework} onChange={(e) => setEdit({ ...edit, telework: e.target.checked })} /> テレワーク（記録は自己申告）</label>
          <label className="ui-field"><span>メモ（代勤・時間変更の理由など）</span><input className="ui-input" value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></label>
          <ModalFoot>
            <div className="ui-modal-foot-end">
              <button type="button" className="btn-plain" onClick={() => setEdit(null)}>キャンセル</button>
              <button type="button" className="btn-primary works-btn-accent" onClick={save}>保存</button>
            </div>
          </ModalFoot>
        </>
      )}
      {staffId && staffId !== 'all' && !edit && <PunchLog date={date} staffId={staffId} editable={editable} onSaved={onSaved} />}
      {error && <div className="works-error">{error}</div>}
    </Modal>
  )
}

// その日の打刻の記録と、管理者の代理入力（スマートフォンを持たない方・打刻忘れの訂正。6-3）
function PunchLog({ date, staffId, editable, onSaved }) {
  const [items, setItems] = useState(null)
  const [form, setForm] = useState(null)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    if (date > todayJst()) return setItems([])
    api(`/api/works/punches?${new URLSearchParams({ staff_id: staffId, date })}`)
      .then((d) => setItems(d.items))
      .catch((e) => setError(e.message))
  }, [date, staffId])
  useEffect(() => {
    load()
  }, [load])
  if (date > todayJst()) return null
  const save = async () => {
    setError('')
    try {
      await api('/api/works/punch/proxy', { method: 'POST', body: { staff_id: staffId, work_date: date, ...form } })
      setForm(null)
      load()
      onSaved()
    } catch (e) {
      setError(e.message)
    }
  }
  return (
    <div className="works-punchlog">
      <strong>打刻の記録</strong>
      {items && items.length === 0 && <p className="works-muted" style={{ margin: 0 }}>打刻はありません。</p>}
      {items && items.length > 0 && (
        <table className="ui-table works-punchlog-table">
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <td>{p.kind === 'in' ? '出勤' : '退勤'}</td>
                <td>{p.time}</td>
                <td>→ {p.adopted}</td>
                <td>
                  {p.site || ''}
                  {p.flag_labels.length > 0 && <span className="works-punch-flags">　{p.flag_labels.join('・')}</span>}
                  {p.distance_m != null && <span className="works-muted">　現場から {p.distance_m}m</span>}
                  {p.lat != null && p.lng != null && (
                    <span className="works-muted">
                      　位置 {p.lat.toFixed(5)}, {p.lng.toFixed(5)}{p.accuracy_m ? `（誤差 約${Math.round(p.accuracy_m)}m）` : ''}{' '}
                      <a href={`https://www.google.com/maps?q=${p.lat},${p.lng}`} target="_blank" rel="noopener noreferrer">地図</a>
                    </span>
                  )}
                  {editable && p.method === 'qr' && p.lat == null && !p.flags?.includes('no_location') && <span className="works-muted">　位置情報なし</span>}
                  {p.note && <span className="works-muted">　{p.note}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editable && !form && (
        <button type="button" className="btn-plain" style={{ marginTop: 6 }} onClick={() => setForm({ kind: 'in', time: '', note: '' })}>
          ＋ 出勤・退勤を代理で入力
        </button>
      )}
      {editable && form && (
        <>
          <div className="ui-field-row">
            <label className="ui-field">
              <span>種類</span>
              <select className="ui-select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                <option value="in">出勤</option>
                <option value="out">退勤</option>
              </select>
            </label>
            <label className="ui-field"><span>時刻</span><input className="ui-input" type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} /></label>
          </div>
          <label className="ui-field"><span>理由（スマートフォンなし・打刻忘れなど）</span><input className="ui-input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
          <p className="ui-note" style={{ margin: 0 }}>打刻と同じく 30 分単位に丸め、予定の時刻にそろえて勤務表に記録します。すでに記録があれば置き換えます。</p>
          <div className="works-row-actions">
            <button type="button" className="btn-primary works-btn-accent" disabled={!form.time} onClick={save}>記録する</button>
          </div>
        </>
      )}
      {error && <div className="works-error">{error}</div>}
    </div>
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
                  <tr key={s.code}><KeyCell name={s.name} code={s.code} /><td>{s.reason}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  )
}
