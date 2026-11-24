// 勤務表一覧（管理者。現行 FileMaker の「勤務表月締め一覧」にあたる）
//   月ごとに、全スタッフの予定の作成状況（日数・時間・手で直した日）と実績の入力状況を一覧する。
//   実績（出勤・退勤の記録）は Phase 3 で入るので、それまでは「—」を出す。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { addMonths, monthRange, todayJst } from '../../../worker/lib/works/time.js'
import { ResultModal } from './Calendar.jsx'
import KeyCell from '../components/KeyCell.jsx'
import AlertBanner from '../components/AlertBanner.jsx'

function monthLabel(ym) {
  const [y, m] = ym.split('-')
  return `${y}年${Number(m)}月`
}

export default function Monthly() {
  const navigate = useNavigate()
  const [month, setMonth] = useState(todayJst().slice(0, 7))
  const [data, setData] = useState(null)
  const [staffInfo, setStaffInfo] = useState({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [result, setResult] = useState(null)

  const load = useCallback(() => {
    setData(null)
    api(`/api/works/shifts?${new URLSearchParams({ month, staff_id: 'all' })}`)
      .then((d) => {
        setData(d)
        setError('')
      })
      .catch((e) => setError(e.message))
  }, [month])
  useEffect(() => {
    load()
  }, [load])
  // この月の未確認の要確認（スタッフごとの件数。月締めの前の確認漏れを防ぐ。8-2）
  const [alertBy, setAlertBy] = useState({})
  useEffect(() => {
    const { from, to } = monthRange(month)
    if (from > todayJst()) return setAlertBy({})
    api(`/api/works/alerts?${new URLSearchParams({ from, to, status: 'open' })}`)
      .then((d) => {
        const m = {}
        for (const a of d.items) m[a.staff_id] = (m[a.staff_id] || 0) + 1
        setAlertBy(m)
      })
      .catch(() => setAlertBy({}))
  }, [month])
  useEffect(() => {
    api('/api/works/staff')
      .then((d) => setStaffInfo(Object.fromEntries(d.items.map((s) => [s.id, s]))))
      .catch(() => {})
  }, [])

  const rows = useMemo(() => {
    if (!data) return []
    const today = todayJst()
    const by = {}
    for (const s of data.items) {
      const r = (by[s.staff_id] ||= { days: new Set(), minutes: 0, manual: 0, due: new Set(), open: new Set() })
      r.days.add(s.work_date)
      r.minutes += s.minutes
      if (s.source === 'manual') r.manual += 1
      // 実績入力: 今日までの予定日のうち、出勤・退勤とも記録がそろった日
      if (s.work_date <= today) {
        r.due.add(s.work_date)
        if (!(s.actual_start && s.actual_end)) r.open.add(s.work_date)
      }
    }
    return (data.staff || []).map((st) => {
      const r = by[st.id] || { days: new Set(), minutes: 0, manual: 0, due: new Set(), open: new Set() }
      const due = r.due.size
      return { ...st, days: r.days.size, minutes: r.minutes, manual: r.manual, due, entered: due - r.open.size, info: staffInfo[st.id] || {} }
    })
  }, [data, staffInfo])
  const total = rows.reduce((a, r) => ({ days: a.days + r.days, minutes: a.minutes + r.minutes }), { days: 0, minutes: 0 })
  const missing = rows.filter((r) => r.days === 0 && r.status === 'active').length

  const generate = async (st) => {
    const who = st ? `${st.code} ${st.name} さん` : '在籍の全員'
    if (!window.confirm(`${monthLabel(month)}の予定を、勤務体系から作り直します（${who}）。\n手で追加・変更した日はそのまま残ります。よろしいですか？`)) return
    setBusy(st ? st.id : 'all')
    try {
      setResult(await api('/api/works/shifts/generate', { method: 'POST', body: { month, staff_id: st ? st.id : undefined } }))
      load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy('')
    }
  }
  const open = (st) => navigate(`/calendar?${new URLSearchParams({ month, staff: st.id })}`)

  return (
    <>
      <div className="works-sticky">
        <h1 className="works-title">勤務表一覧</h1>
        <div className="works-row-actions">
          <button type="button" className="works-arrow" onClick={() => setMonth(addMonths(month, -1))} aria-label="前の月">‹</button>
          <strong className="works-month">{monthLabel(month)}</strong>
          <button type="button" className="works-arrow" onClick={() => setMonth(addMonths(month, 1))} aria-label="次の月">›</button>
          <button type="button" className="btn-plain" onClick={() => setMonth(todayJst().slice(0, 7))}>今月</button>
          <span className="works-sep" />
          <button type="button" className="btn-primary works-btn-accent" disabled={!!busy} onClick={() => generate(null)}>
            {busy === 'all' ? '作成中…' : '予定を一括作成'}
          </button>
        </div>
      </div>
      <AlertBanner />
      {data && (
        <p className="ui-note" style={{ marginTop: 0 }}>
          {missing > 0 ? <span className="works-none">予定が未作成の在籍スタッフが {missing} 名います。</span> : '在籍スタッフ全員の予定が作成済みです。'}
          {data.last_auto_month ? `（最後に自動作成: ${monthLabel(data.last_auto_month)}分）` : ''}
        </p>
      )}
      {error && <p className="works-error">{error}</p>}
      {!data && !error && <p className="works-muted">読み込み中…</p>}
      {data && (
        <div className="ui-table-wrap works-scroll">
          <table className="ui-table works-monthly works-clickable">
            <thead>
              <tr>
                <th className="works-key">氏名</th>
                <th className="num">予定日数</th>
                <th className="num">予定時間</th>
                <th className="num">手で変更</th>
                <th className="center">実績入力</th>
                <th className="center">要確認</th>
                <th className="center">休館日勤務</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => open(r)}>
                  <KeyCell name={r.name} code={r.code}>
                    {r.status === 'leave' && <span className="ui-badge is-warn" style={{ marginLeft: 6 }}>休職</span>}
                  </KeyCell>
                  <td className="num">{r.days ? `${r.days}日` : <span className={r.status === 'active' ? 'works-none' : 'works-muted'}>未作成</span>}</td>
                  <td className="num">{r.minutes ? (r.minutes / 60).toFixed(2) : ''}</td>
                  <td className="num">{r.manual ? `${r.manual}件` : ''}</td>
                  <td className="center">
                    {r.due ? <span className={r.entered < r.due ? 'works-none' : ''}>{r.entered}/{r.due}日</span> : <span className="works-muted">—</span>}
                  </td>
                  <td className="center">{alertBy[r.id] ? <span className="works-none">{alertBy[r.id]}件</span> : ''}</td>
                  <td className="center">{r.info.closed_day_work ? '勤務する' : ''}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="btn-plain" disabled={!!busy} onClick={() => generate(r)}>
                      {busy === r.id ? '作成中…' : r.days ? '作り直す' : '作成'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th className="works-key">合計（{rows.length}名）</th>
                <th className="num">{total.days}日</th>
                <th className="num">{(total.minutes / 60).toFixed(2)}</th>
                <th colSpan={5} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="ui-note">行をタップすると、そのスタッフのカレンダーを開きます。実績入力は、今日までの予定の日のうち出勤・退勤の記録がそろった日数です（足りないときは赤）。要確認は、この月の未確認の件数です。</p>
      {result && <ResultModal result={result} onClose={() => setResult(null)} />}
    </>
  )
}
