// 有給休暇（管理者）。スタッフごとの今の期間の付与・繰越・取得・残日数と特別休暇、年 5 日の取得状況。
//   計算は worker/lib/works/leave.js（docs/eworks-spec-leave.md）。行をタップすると期間ごとの履歴と取得日。
import { useCallback, useEffect, useState } from 'react'
import Modal from '../components/Modal.jsx'
import { api, WEEKDAYS } from '../lib/api.js'
import { todayJst } from '../../../worker/lib/works/time.js'
import LeaveRequestForm from '../components/LeaveRequestForm.jsx'
import LeaveRequestList from '../components/LeaveRequestList.jsx'
import LeaveSheet from '../components/LeaveSheet.jsx'
import KeyCell from '../components/KeyCell.jsx'

const ymdLabel = (d) => (d ? d.replaceAll('-', '/') : '')
// 取得の日数はマイナスで見せる（0 はそのまま）
const neg = (n) => (n ? `−${n}` : 0)
const withDow = (d) => `${ymdLabel(d)}（${WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]}）`

export default function Leave() {
  const [at, setAt] = useState(todayJst())
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(null)
  const [tab, setTab] = useState('list')
  const [reqStatus, setReqStatus] = useState('pending')
  const [reqs, setReqs] = useState(null)
  const [pending, setPending] = useState(0)
  const [form, setForm] = useState(false)
  const [print, setPrint] = useState(null)
  const loadReqs = useCallback(() => {
    api(`/api/works/leave/requests?${new URLSearchParams({ status: reqStatus })}`)
      .then((d) => {
        setReqs(d.items)
        setPending(d.pending)
      })
      .catch((e) => setError(e.message))
  }, [reqStatus])
  useEffect(() => {
    loadReqs()
  }, [loadReqs])
  const changed = () => {
    load()
    loadReqs()
  }

  const load = useCallback(() => {
    api(`/api/works/leave?${new URLSearchParams({ at })}`)
      .then((d) => {
        setData(d)
        setError('')
      })
      .catch((e) => setError(e.message))
  }, [at])
  useEffect(() => {
    load()
  }, [load])

  const items = data?.items || []
  const short = items.filter((r) => r.period?.five_day_short > 0).length

  return (
    <>
      <div className="works-sticky">
        <h1 className="works-title">有給休暇の管理</h1>
        <div className="works-row-actions">
          <div className="ui-segmented">
            <button type="button" className={`ui-segmented-btn ${tab === 'list' ? 'is-active' : ''}`} onClick={() => setTab('list')}>残日数の一覧</button>
            <button type="button" className={`ui-segmented-btn ${tab === 'requests' ? 'is-active' : ''}`} onClick={() => setTab('requests')}>
              申請{pending > 0 && <span className="works-count">{pending}</span>}
            </button>
          </div>
          {tab === 'list' ? (
            <>
          <label className="works-inline-field">
            基準日
            <input className="ui-input" type="date" value={at} onChange={(e) => e.target.value && setAt(e.target.value)} />
          </label>
          <button type="button" className="btn-plain" onClick={() => setAt(todayJst())}>今日</button>
            </>
          ) : (
            <>
              <button type="button" className="btn-primary works-btn-accent" onClick={() => setForm(true)} disabled={!data}>＋ 紙の申請書を入力</button>
              <button type="button" className="btn-plain" onClick={() => setPrint({ request: null })}>空欄の申請書を印刷</button>
            </>
          )}
        </div>
      </div>
      {tab === 'requests' && (
        <>
          <div className="works-row-actions" style={{ marginBottom: 8 }}>
            <div className="ui-segmented">
              <button type="button" className={`ui-segmented-btn ${reqStatus === 'pending' ? 'is-active' : ''}`} onClick={() => setReqStatus('pending')}>承認待ち</button>
              <button type="button" className={`ui-segmented-btn ${reqStatus === 'all' ? 'is-active' : ''}`} onClick={() => setReqStatus('all')}>すべて</button>
            </div>
          </div>
          {reqs ? <LeaveRequestList items={reqs} admin onChanged={changed} onPrint={(r) => setPrint({ request: r, name: r.staff?.name })} /> : <p className="works-muted">読み込み中…</p>}
          <p className="ui-note">承認すると取得日に入ります。紙の申請書で受け付けた分は「紙の申請書を入力」から登録してください（承認済みで入ります）。</p>
        </>
      )}
      {tab === 'list' && (
      <>
      {data && short > 0 && (
        <p className="ui-note" style={{ marginTop: 0 }}>
          <span className="works-none">年 5 日の取得がまだ足りない人が {short} 名います</span>（付与 10 日以上の人は、期間内に 5 日取る義務があります）。
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
                <th>今の期間</th>
                <th className="num">繰越</th>
                <th className="num">付与</th>
                <th className="num">取得</th>
                <th className="num">残日数</th>
                <th className="num">期末で消滅</th>
                <th className="center">年5日</th>
                <th className="num">特別休暇</th>
                <th className="num">当月の取得</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => {
                const p = r.period
                return (
                  <tr key={r.staff_id} onClick={() => setOpen(r)}>
                    <KeyCell name={r.name} code={r.code}>
                      {r.status === 'leave' && <span className="ui-badge is-warn" style={{ marginLeft: 6 }}>休職</span>}
                    </KeyCell>
                    {p ? (
                      <>
                        <td style={{ whiteSpace: 'nowrap' }}>{ymdLabel(p.start)}〜{ymdLabel(p.end)}</td>
                        <td className="num">{p.carry}</td>
                        <td className="num">{p.grant}</td>
                        <td className="num">{p.taken}</td>
                        <td className="num"><strong>{p.remain}</strong></td>
                        <td className="num">{p.expire ? <span className="works-warn-text">{p.expire}</span> : 0}</td>
                        <td className="center">
                          {p.five_day_short == null ? <span className="works-muted">—</span> : p.five_day_short > 0 ? <span className="works-none">あと{p.five_day_short}日</span> : '達成'}
                        </td>
                        <td className="num">{p.special_taken}/{p.special_grant}</td>
                      </>
                    ) : (
                      <td colSpan={8} className="works-muted">
                        {r.hired_on ? `最初の付与は ${ymdLabel(r.first_grant)}` : '入社日が未登録'}
                      </td>
                    )}
                    <td className="num">{r.month_paid || r.month_special ? `有休${r.month_paid}・特休${r.month_special}` : ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {items.length === 0 && <div className="ui-empty">スタッフがいません</div>}
        </div>
      )}
      <p className="ui-note">
        数え方は現行（FileMaker）と同じです。繰越分から先に使い、使い切れなかった繰越分は期間末に消えます。特別休暇は有休の付与がある期間に 5 日で、取った日は有休も 1 日として数えます。行をタップすると期間ごとの履歴と取得日を見られます。
      </p>
      </>
      )}
      {form && (
        <LeaveRequestForm
          staffList={items}
          onClose={() => setForm(false)}
          onSaved={() => {
            setForm(false)
            setReqStatus('all')
            changed()
          }}
        />
      )}
      {print && <LeaveSheet request={print.request} name={print.name} onClose={() => setPrint(null)} />}
      {open && <LeaveDetail row={open} at={at} onClose={() => setOpen(null)} onChanged={load} />}
    </>
  )
}

function LeaveDetail({ row, at, onClose, onChanged }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [add, setAdd] = useState({ date: todayJst(), kind: 'paid', note: '' })
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    api(`/api/works/leave?${new URLSearchParams({ staff_id: row.staff_id, at })}`)
      .then((d) => setData(d))
      .catch((e) => setError(e.message))
  }, [row.staff_id, at])
  useEffect(() => {
    load()
  }, [load])

  const idOf = (date, kind) => data?.items.find((i) => i.leave_date === date && i.kind === kind)
  const save = async () => {
    setError('')
    setBusy(true)
    try {
      await api('/api/works/leave', { method: 'POST', body: { staff_id: row.staff_id, ...add } })
      load()
      onChanged()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  const remove = async (item) => {
    const label = item.kind === 'special' ? '特別休暇（同じ日の有休も）' : '有給休暇'
    if (!window.confirm(`${withDow(item.leave_date)} の${label}を取り消します。よろしいですか？`)) return
    try {
      await api(`/api/works/leave?id=${item.id}`, { method: 'DELETE' })
      load()
      onChanged()
    } catch (e) {
      setError(e.message)
    }
  }
  const cur = data?.periods?.[0]

  return (
    <Modal title={`${row.code} ${row.name} の有給休暇`} onClose={onClose} size="lg">
      {error && <div className="works-error">{error}</div>}
      {!data && !error && <p className="works-muted">読み込み中…</p>}
      {data && (
        <>
          <p style={{ margin: 0 }}>
            入社日 {ymdLabel(data.staff.hired_on) || '未登録'}
            {cur && <>　今の期間 {ymdLabel(cur.start)}〜{ymdLabel(cur.end)}　<strong>残 {cur.remain} 日</strong>（繰越 {cur.carry}＋付与 {cur.grant}−取得 {cur.taken}）</>}
          </p>

          {cur && (
            <section className="works-section">
              <h3 className="works-section-title">今の期間の取得日</h3>
              {cur.paid_days.length === 0 && cur.special_days.length === 0 && <p className="works-muted" style={{ margin: 0 }}>まだありません</p>}
              <div className="works-leave-days">
                {cur.paid_days.map((d) => {
                  const sp = cur.special_days.includes(d)
                  const item = idOf(d, sp ? 'special' : 'paid') || idOf(d, 'paid')
                  return (
                    <span key={d} className={`works-leave-day ${sp ? 'is-special' : ''}`}>
                      {withDow(d)}{sp ? ' 特休' : ''}
                      {item && <button type="button" aria-label="取り消す" onClick={() => remove(item)}>×</button>}
                    </span>
                  )
                })}
                {cur.special_days.filter((d) => !cur.paid_days.includes(d)).map((d) => {
                  const item = idOf(d, 'special')
                  return (
                    <span key={`s${d}`} className="works-leave-day is-special">
                      {withDow(d)} 特休のみ
                      {item && <button type="button" aria-label="取り消す" onClick={() => remove(item)}>×</button>}
                    </span>
                  )
                })}
              </div>
              <div className="works-row-actions">
                <input className="ui-input" style={{ width: 'auto' }} type="date" value={add.date} onChange={(e) => setAdd({ ...add, date: e.target.value })} />
                <select className="ui-select" style={{ width: 'auto' }} value={add.kind} onChange={(e) => setAdd({ ...add, kind: e.target.value })}>
                  <option value="paid">有給休暇</option>
                  <option value="special">特別休暇（祝日のみ）</option>
                </select>
                <button type="button" className="btn-primary works-btn-accent" disabled={busy || !add.date} onClick={save}>取得日を登録</button>
              </div>
              <p className="ui-note" style={{ margin: 0 }}>特別休暇を登録すると、同じ日の有給休暇も登録します。並行運用中は FileMaker にも同じように登録してください。</p>
            </section>
          )}

          <section className="works-section">
            <h3 className="works-section-title">期間ごとの履歴</h3>
            {data.periods.length === 0 ? (
              <p className="works-muted" style={{ margin: 0 }}>まだ付与がありません{row.first_grant ? `（最初の付与は ${ymdLabel(row.first_grant)}）` : ''}</p>
            ) : (
              <div className="works-leave-history">
                <div className="ui-table-wrap">
                  <table className="ui-table works-monthly works-leave-periods">
                    <thead>
                      <tr>
                        <th className="works-key">期間</th>
                        <th className="num">繰越</th>
                        <th className="num">付与</th>
                        <th className="num works-vl">取得</th>
                        <th className="num">（繰越）</th>
                        <th className="num works-vr">（付与）</th>
                        <th className="num">残日数</th>
                        <th className="num">期末で消滅</th>
                        <th className="num">特別休暇</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.periods.map((p) => (
                        <tr key={p.start}>
                          <td className="works-key">{ymdLabel(p.start)}〜</td>
                          <td className="num">{p.carry}</td>
                          <td className="num">{p.grant}</td>
                          <td className="num works-vl"><strong>{neg(p.taken)}</strong></td>
                          <td className="num">{neg(p.from_carry)}</td>
                          <td className="num works-vr">{neg(p.from_grant)}</td>
                          <td className="num"><strong>{p.remain}</strong></td>
                          <td className="num">{p.expire}</td>
                          <td className="num">{p.special_taken}/{p.special_grant}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <TakenDays periods={data.periods} />
              </div>
            )}
          </section>
        </>
      )}
    </Modal>
  )
}

// 有給休暇取得履歴（これまでに取った日の一覧。2026-11-25 依頼元の要望）。
//   新しい期間から順に、期間の区切りは太線。特別休暇の日は右に（特）
function TakenDays({ periods }) {
  const rows = periods.flatMap((p) => {
    const special = new Set(p.special_days || [])
    const days = [...new Set([...(p.paid_days || []), ...special])].sort().reverse()
    return days.map((d, i) => ({ d, special: special.has(d), periodStart: p.start, first: i === 0 }))
  })
  return (
    <div className="works-leave-taken">
      <div className="works-leave-taken-title">有給休暇取得履歴（{rows.length}日）</div>
      {rows.length === 0 ? (
        <p className="works-muted" style={{ margin: 0 }}>まだありません</p>
      ) : (
        <div className="ui-table-wrap works-leave-taken-scroll">
          <table className="ui-table">
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.periodStart}-${r.d}`} className={r.first ? 'is-period-start' : ''}>
                  <td className="works-nowrap">
                    {withDow(r.d)}
                    {r.special && <span className="works-special-mark">（特）</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
