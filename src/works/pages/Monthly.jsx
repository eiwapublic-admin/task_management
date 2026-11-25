// 勤務表一覧（管理者。現行 FileMaker の「勤務表月締め一覧」にあたる）
//   月ごとに、全スタッフの予定の作成状況（日数・時間・手で直した日）と実績の入力状況を一覧する。
//   2026-11-25: 休館日勤務の列をやめて「出退勤の入力」、実績入力の右に「予実差異」。行のボタンはプリンタ（出勤簿）と「予定再作成」
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { addMonths, monthRange, todayJst } from '../../../worker/lib/works/time.js'
import { ResultModal } from './Calendar.jsx'
import KeyCell from '../components/KeyCell.jsx'
import AlertBanner from '../components/AlertBanner.jsx'
import useAttendanceSheetPdf from '../components/useAttendanceSheetPdf.jsx'
import HelpTip from '../components/HelpTip.jsx'
import TabIcon from '../components/TabIcons.jsx'

// 出退勤の入力方法（スタッフ一覧と同じ表記）
const METHOD_SHORT = { qr: 'QR', self: '本人', proxy: '管理者' }

// 予実差異（実績の時間 − 予定の時間）。0.5 時間なら「+0.50」、少なければ「−」
function diffLabel(min) {
  if (!min) return '0'
  return `${min > 0 ? '+' : '−'}${(Math.abs(min) / 60).toFixed(2)}`
}

function monthLabel(ym) {
  const [y, m] = ym.split('-')
  return `${y}年${Number(m)}月`
}

export default function Monthly() {
  const navigate = useNavigate()
  const [month, setMonth] = useState(todayJst().slice(0, 7))
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [result, setResult] = useState(null)
  const sheetPdf = useAttendanceSheetPdf()

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

  const rows = useMemo(() => {
    if (!data) return []
    const today = todayJst()
    const by = {}
    for (const s of data.items) {
      const r = (by[s.staff_id] ||= { days: new Set(), minutes: 0, manual: 0, due: new Set(), open: new Set(), diff: 0 })
      r.days.add(s.work_date)
      r.minutes += s.minutes
      if (s.source === 'manual') r.manual += 1
      // 実績入力: 今日までの予定日のうち、出勤・退勤とも記録がそろった日
      if (s.work_date <= today) {
        r.due.add(s.work_date)
        if (!(s.actual_start && s.actual_end)) r.open.add(s.work_date)
      }
      // 予実差異: 出勤・退勤がそろった勤務と、今日より前で実績がそろっていない勤務（実績 0 時間として数える）
      if (s.actual_minutes != null) r.diff += s.actual_minutes - s.minutes
      else if (s.work_date < today) r.diff -= s.minutes
    }
    return (data.staff || []).map((st) => {
      const r = by[st.id] || { days: new Set(), minutes: 0, manual: 0, due: new Set(), open: new Set(), diff: 0 }
      const due = r.due.size
      return { ...st, days: r.days.size, minutes: r.minutes, manual: r.manual, due, entered: due - r.open.size, diff: r.diff }
    })
  }, [data])
  const total = rows.reduce((a, r) => ({ days: a.days + r.days, minutes: a.minutes + r.minutes }), { days: 0, minutes: 0 })
  // 月が終わったのに予実差異が 0 でなければ赤の太字（2026-11-25 依頼元の要望）
  const monthOver = month < todayJst().slice(0, 7)
  const missing = rows.filter((r) => r.days === 0 && r.status === 'active').length
  // 出勤簿の一括印刷の対象（入力方法が「管理者が代理入力」の人）
  const proxyCount = rows.filter((r) => r.punch_method === 'proxy').length

  const generate = async (st) => {
    const who = st ? `${st.code} ${st.name} さん` : '在籍の全員'
    if (!window.confirm(`${monthLabel(month)}の予定を、勤務体系から作り直します（${who}）。\n手で追加・変更した日と、出勤・退勤の記録がある日はそのまま残ります。よろしいですか？`)) return
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
        <h1 className="works-title">勤務一覧</h1>
        <div className="works-row-actions">
          <button type="button" className="works-arrow" onClick={() => setMonth(addMonths(month, -1))} aria-label="前の月">‹</button>
          <strong className="works-month">{monthLabel(month)}</strong>
          <button type="button" className="works-arrow" onClick={() => setMonth(addMonths(month, 1))} aria-label="次の月">›</button>
          <button type="button" className="btn-plain" onClick={() => setMonth(todayJst().slice(0, 7))}>今月</button>
          <span className="works-sep" />
          <button type="button" className="btn-primary works-btn-accent" disabled={!!busy} onClick={() => generate(null)}>
            {busy === 'all' ? '作成中…' : '予定を一括作成'}
          </button>
          <button
            type="button"
            className="btn-plain"
            disabled={!!busy || sheetPdf.busy || !data}
            onClick={() => sheetPdf.open(month, 'proxy')}
            title="入力方法が「管理者が代理入力」のスタッフ全員の出勤簿（入力用の用紙）を 1 つの PDF にします"
          >
            出勤簿を一括印刷（代理入力{data ? ` ${proxyCount}名` : ''}）
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
      {sheetPdf.error && <p className="works-error">{sheetPdf.error}</p>}
      {!data && !error && <p className="works-muted">読み込み中…</p>}
      {data && (
        <div className="ui-table-wrap works-scroll">
          <table className="ui-table works-monthly works-clickable">
            <thead>
              <tr>
                <th className="works-key">氏名</th>
                <th className="num">予定日数</th>
                <th className="num">予定時間</th>
                <th className="num works-nowrap">手で変更<HelpTip text="管理者が手で追加・変更した予定の件数です。予定を作り直しても、これらの日はそのまま残ります。" /></th>
                <th className="center">実績入力</th>
                <th className="num works-nowrap">予実差異<HelpTip text="実績の時間から予定の時間を引いた合計です（時間）。予定より少なければマイナス。今日より前で出勤・退勤がそろっていない日は 0 時間として数えます。月が終わっても 0 でなければ赤の太字になります。" /></th>
                <th className="center works-nowrap">要確認<HelpTip text="この月の、まだ確認していない要確認（遅刻・早退・打刻漏れ・位置の不一致など）の件数です。月締めの前に「要確認」画面で確認してください。" /></th>
                <th className="center works-nowrap">出退勤の入力</th>
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
                  <td className={`num works-nowrap ${monthOver && r.diff ? 'works-diff' : ''}`}>{r.days ? diffLabel(r.diff) : ''}</td>
                  <td className="center">{alertBy[r.id] ? <span className="works-none">{alertBy[r.id]}件</span> : ''}</td>
                  <td className="center works-nowrap">{METHOD_SHORT[r.punch_method || 'qr']}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="works-row-tools">
                    <button type="button" className="btn-primary works-btn-accent works-print-btn" disabled={!!busy || sheetPdf.busy} onClick={() => sheetPdf.open(month, r.id)} title="出勤簿を印刷" aria-label="出勤簿を印刷">
                      <TabIcon name="printer" size={20} />
                    </button>
                    <button type="button" className="works-link-blue" disabled={!!busy} onClick={() => generate(r)}>
                      {busy === r.id ? '作成中…' : r.days ? '予定再作成' : '予定作成'}
                    </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th className="works-key">合計（{rows.length}名）</th>
                <th className="num">{total.days}日</th>
                <th className="num">{(total.minutes / 60).toFixed(2)}</th>
                <th colSpan={6} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="ui-note">「出勤簿を一括印刷」は、入力方法が「管理者が代理入力」のスタッフ全員の出勤簿（予定を薄い字で印字した入力用の用紙）を 1 つの PDF にします。1 人分は各行のプリンタのボタンから出せます。行をタップすると、そのスタッフのカレンダーを開きます。実績入力は、今日までの予定の日のうち出勤・退勤の記録がそろった日数です（足りないときは赤）。見出しの「?」を押すと各欄の説明が出ます。</p>
      {result && <ResultModal result={result} onClose={() => setResult(null)} />}
      {sheetPdf.ui}
    </>
  )
}
