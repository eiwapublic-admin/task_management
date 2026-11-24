// 要確認（管理者。docs/eworks-plan.md 8-2）
//   予定と実績の相違の一覧。日付・スタッフ・種別で絞り込み、行を押すとその日の画面を開いてその場で確認・訂正する。
//   「確認済み」にすると一覧から消え、「確認済み」の絞り込みで見られる。打刻の修正申請の承認もここで行う
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, WEEKDAYS } from '../lib/api.js'
import { addMonths, dow, monthRange, todayJst } from '../../../worker/lib/works/time.js'
import KeyCell from '../components/KeyCell.jsx'
import PunchRequestList from '../components/PunchRequestList.jsx'
import { LEVEL_BADGE } from '../lib/alerts.js'
import { DayModal } from './Calendar.jsx'

const KINDS = [
  ['absent', '未出勤'],
  ['late', '遅刻'],
  ['early', '早退'],
  ['no_out', '退勤漏れ'],
  ['overtime', '超過'],
  ['no_plan', '予定外の出勤'],
  ['site_mismatch', '現場違い'],
  ['location', '位置の不一致'],
  ['leave_punch', '休暇日の打刻'],
  ['corrected', '訂正あり'],
]
const dayLabel = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}（${WEEKDAYS[dow(d)]}）`
function monthLabel(ym) {
  const [y, m] = ym.split('-')
  return `${y}年${Number(m)}月`
}

export default function Alerts() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'requests' ? 'requests' : 'alerts'
  const setTab = (t) => setParams(t === 'requests' ? { tab: t } : {}, { replace: true })
  const [period, setPeriod] = useState('recent') // recent = 先月から今日まで / YYYY-MM
  const [status, setStatus] = useState('open')
  const [staffId, setStaffId] = useState('')
  const [kind, setKind] = useState('')
  const [data, setData] = useState(null)
  const [requests, setRequests] = useState(null)
  const [reqStatus, setReqStatus] = useState('pending')
  const [selected, setSelected] = useState(new Set())
  const [open, setOpen] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    const q = new URLSearchParams({ status })
    if (period !== 'recent') {
      const { from, to } = monthRange(period)
      q.set('from', from)
      q.set('to', to)
    }
    api(`/api/works/alerts?${q}`)
      .then((d) => {
        setData(d)
        setSelected(new Set())
        setError('')
      })
      .catch((e) => setError(e.message))
  }, [period, status])
  const loadRequests = useCallback(() => {
    api(`/api/works/punch-requests?status=${reqStatus}`).then((d) => setRequests(d.items)).catch((e) => setError(e.message))
  }, [reqStatus])
  useEffect(() => {
    load()
  }, [load])
  useEffect(() => {
    loadRequests()
  }, [loadRequests])
  const refresh = () => {
    load()
    loadRequests()
    window.dispatchEvent(new Event('works-alerts-changed'))
  }

  const staffList = useMemo(() => {
    const m = new Map()
    for (const a of data?.items || []) if (a.staff) m.set(a.staff.id, a.staff)
    return [...m.values()].sort((a, b) => (a.code < b.code ? -1 : 1))
  }, [data])
  const items = (data?.items || []).filter((a) => (!staffId || a.staff_id === staffId) && (!kind || a.kind === kind))
  const counts = useMemo(() => {
    const c = {}
    for (const a of data?.items || []) c[a.kind] = (c[a.kind] || 0) + 1
    return c
  }, [data])
  const toggle = (k) => {
    const n = new Set(selected)
    if (n.has(k)) n.delete(k)
    else n.add(k)
    setSelected(n)
  }
  const resolve = async (undo) => {
    let note = ''
    if (!undo) {
      note = window.prompt(`選んだ ${selected.size} 件を確認済みにします。メモ（任意）`, '')
      if (note === null) return
    } else if (!window.confirm(`選んだ ${selected.size} 件の確認済みを取り消します。よろしいですか？`)) return
    setBusy(true)
    try {
      await api('/api/works/alerts/resolve', { method: 'POST', body: { keys: [...selected], note, undo } })
      refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  const pendingCount = reqStatus === 'pending' ? requests?.length || 0 : null
  const thisMonth = todayJst().slice(0, 7)

  return (
    <>
      <div className="works-sticky">
        <h1 className="works-title">要確認</h1>
        <div className="works-row-actions">
          <div className="ui-segmented">
            <button type="button" className={`ui-segmented-btn ${tab === 'alerts' ? 'is-active' : ''}`} onClick={() => setTab('alerts')}>
              予定と実績の相違{data && status === 'open' ? ` ${data.items.length}` : ''}
            </button>
            <button type="button" className={`ui-segmented-btn ${tab === 'requests' ? 'is-active' : ''}`} onClick={() => setTab('requests')}>
              修正申請{pendingCount ? ` ${pendingCount}` : ''}
            </button>
          </div>
        </div>
        {tab === 'alerts' && (
          <div className="works-row-actions">
            <select className="ui-select works-staff-select" value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value="recent">先月から今日まで</option>
              {[0, -1, -2, -3, -4, -5].map((n) => {
                const m = addMonths(thisMonth, n)
                return <option key={m} value={m}>{monthLabel(m)}</option>
              })}
            </select>
            <div className="ui-segmented">
              <button type="button" className={`ui-segmented-btn ${status === 'open' ? 'is-active' : ''}`} onClick={() => setStatus('open')}>未確認</button>
              <button type="button" className={`ui-segmented-btn ${status === 'resolved' ? 'is-active' : ''}`} onClick={() => setStatus('resolved')}>確認済み</button>
            </div>
            <select className="ui-select works-staff-select" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
              <option value="">スタッフ: すべて</option>
              {staffList.map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}
            </select>
            <select className="ui-select works-staff-select" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">種別: すべて</option>
              {KINDS.map(([k, l]) => <option key={k} value={k}>{l}{counts[k] ? `（${counts[k]}）` : ''}</option>)}
            </select>
          </div>
        )}
        {tab === 'alerts' && selected.size > 0 && (
          <div className="works-row-actions">
            <span>{selected.size} 件を選択中</span>
            {status === 'open' ? (
              <button type="button" className="btn-primary works-btn-accent" disabled={busy} onClick={() => resolve(false)}>確認済みにする</button>
            ) : (
              <button type="button" className="btn-plain" disabled={busy} onClick={() => resolve(true)}>確認済みを取り消す</button>
            )}
            <button type="button" className="btn-plain" onClick={() => setSelected(new Set())}>選択を解除</button>
          </div>
        )}
      </div>
      {error && <p className="works-error">{error}</p>}

      {tab === 'alerts' && !data && !error && <p className="works-muted">読み込み中…</p>}
      {tab === 'alerts' && data && (
        <>
          {items.length === 0 ? (
            <div className="ui-empty">{status === 'open' ? '未確認の要確認はありません' : '確認済みのものはありません'}</div>
          ) : (
            <div className="ui-table-wrap works-scroll">
              <table className="ui-table works-alerts works-clickable">
                <thead>
                  <tr>
                    <th className="center">
                      <input
                        type="checkbox"
                        aria-label="すべて選ぶ"
                        checked={items.length > 0 && items.every((a) => selected.has(a.key))}
                        onChange={(e) => setSelected(e.target.checked ? new Set(items.map((a) => a.key)) : new Set())}
                      />
                    </th>
                    <th className="works-key">スタッフ</th>
                    <th>日付</th>
                    <th>種別</th>
                    <th>内容</th>
                    <th>予定</th>
                    {status === 'resolved' && <th>確認</th>}
                  </tr>
                </thead>
                <tbody>
                  {items.map((a) => (
                    <tr key={a.key} onClick={() => setOpen(a)}>
                      <td className="center" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" aria-label="選ぶ" checked={selected.has(a.key)} onChange={() => toggle(a.key)} />
                      </td>
                      <KeyCell name={a.staff?.name || ''} code={a.staff?.code} />
                      <td className="nowrap">{dayLabel(a.work_date)}</td>
                      <td><span className={`ui-badge ${LEVEL_BADGE[a.level]}`}>{a.label}</span></td>
                      <td>{a.detail}{a.site ? <span className="works-muted">　{a.site.name}</span> : null}</td>
                      <td className="nowrap">{a.plan || ''}</td>
                      {status === 'resolved' && (
                        <td className="nowrap works-muted">{a.resolved_at ? new Date(a.resolved_at).toLocaleDateString('ja-JP') : ''}{a.note ? `　${a.note}` : ''}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="ui-note">
            行を押すとその日の画面を開き、記録の確認・訂正と「確認済み」ができます。未出勤・退勤漏れは入力方法が「QR」でアプリに登録済みのスタッフだけ、位置の不一致は現場の緯度・経度を登録した現場だけを見ます。
            {data.from && `（期間 ${data.from.replaceAll('-', '/')}〜${data.to.replaceAll('-', '/')}）`}
          </p>
        </>
      )}

      {tab === 'requests' && (
        <>
          <div className="works-row-actions">
            <div className="ui-segmented">
              <button type="button" className={`ui-segmented-btn ${reqStatus === 'pending' ? 'is-active' : ''}`} onClick={() => setReqStatus('pending')}>承認待ち</button>
              <button type="button" className={`ui-segmented-btn ${reqStatus === 'all' ? 'is-active' : ''}`} onClick={() => setReqStatus('all')}>すべて</button>
            </div>
          </div>
          {requests === null ? (
            <p className="works-muted">読み込み中…</p>
          ) : (
            <PunchRequestList items={requests} admin onChanged={refresh} onOpen={(r) => setOpen({ staff_id: r.staff_id, staff: r.staff, work_date: r.work_date })} />
          )}
        </>
      )}

      {open && <AlertDay alert={open} onClose={() => setOpen(null)} onSaved={refresh} />}
    </>
  )
}

// 要確認の行から開く日の画面（カレンダーの日の画面と同じもの）
function AlertDay({ alert, onClose, onSaved }) {
  const [data, setData] = useState(null)
  const [sites, setSites] = useState([])
  const [error, setError] = useState('')
  const month = alert.work_date.slice(0, 7)
  const load = useCallback(() => {
    api(`/api/works/shifts?${new URLSearchParams({ month, staff_id: alert.staff_id })}`).then(setData).catch((e) => setError(e.message))
  }, [month, alert.staff_id])
  useEffect(() => {
    load()
    api('/api/works/sites').then((d) => setSites(d.items.filter((s) => s.active))).catch(() => {})
  }, [load])
  if (error) return <p className="works-error">{error}</p>
  if (!data) return null
  const staff = (data.staff || []).find((s) => s.id === alert.staff_id) || alert.staff
  return (
    <DayModal
      date={alert.work_date}
      data={data}
      staff={staff}
      staffId={alert.staff_id}
      sites={sites}
      editable
      actualEditable
      onClose={onClose}
      onSaved={() => {
        load()
        onSaved()
      }}
    />
  )
}
