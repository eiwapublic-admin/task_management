// 「スタッフ別」のカレンダーの下に出す、そのスタッフの有給休暇の取得状況・残日数と申請（管理者）。
//   2026-11-24 依頼元の要望で「休暇」画面を廃止し、ここへ移した。申請の入力はカレンダーの日の詳細から
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, WEEKDAYS } from '../lib/api.js'
import LeaveRequestList from './LeaveRequestList.jsx'
import LeaveSheet from './LeaveSheet.jsx'

const ymd = (d) => (d ? d.replaceAll('-', '/') : '')
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}（${WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]}）`

export default function StaffLeavePanel({ staff, version = 0, onLoaded }) {
  const [data, setData] = useState(null)
  const [reqs, setReqs] = useState(null)
  const [error, setError] = useState('')
  const [print, setPrint] = useState(null)
  const load = useCallback(() => {
    setError('')
    Promise.all([
      api(`/api/works/leave?${new URLSearchParams({ staff_id: staff.id })}`),
      api(`/api/works/leave/requests?${new URLSearchParams({ status: 'all', staff_id: staff.id })}`),
    ])
      .then(([d, r]) => {
        setData(d)
        setReqs(r.items.slice(0, 10))
        onLoaded?.(d.summary)
      })
      .catch((e) => setError(e.message))
  }, [staff.id, onLoaded])
  useEffect(() => {
    load()
  }, [load, version])
  const p = data?.summary?.period
  const cur = data?.periods?.[0]

  return (
    <section className="works-leave-panel">
      <h2 className="works-subtitle">有給休暇（{staff.name} さん）</h2>
      {error && <p className="works-error">{error}</p>}
      {!data && !error && <p className="works-muted">読み込み中…</p>}
      {data && (
        <div className="ui-card works-leave-mine">
          {p ? (
            <>
              <div className="works-leave-big">
                <div><span>有給休暇の残り</span><strong>{p.remain}</strong>日</div>
                <div><span>特別休暇の残り</span><strong>{p.special_remain}</strong>日</div>
              </div>
              <div className="works-muted">
                今の期間 {ymd(p.start)}〜{ymd(p.end)}（繰越 {p.carry} 日＋付与 {p.grant} 日、取得 {p.taken} 日）
                {p.expire > 0 && <>。<span className="works-warn-text">繰越のうち {p.expire} 日は {ymd(p.end)} で消えます</span></>}
              </div>
              {p.five_day_short > 0 && <div className="works-none">年 5 日の取得まで、あと {p.five_day_short} 日です。</div>}
              {cur && (cur.paid_days.length > 0 || cur.special_days.length > 0) && (
                <div className="works-leave-days" style={{ marginTop: 8 }}>
                  {cur.paid_days.map((d) => (
                    <span key={d} className={`works-leave-day ${cur.special_days.includes(d) ? 'is-special' : ''}`} style={{ paddingRight: 10 }}>
                      {md(d)}{cur.special_days.includes(d) ? ' 特休' : ''}
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="works-muted">{data.summary.first_grant ? `最初の有給休暇は ${ymd(data.summary.first_grant)} に付与されます。` : '入社日が未登録のため、有給休暇を計算できません。'}</div>
          )}
        </div>
      )}
      {reqs && reqs.length > 0 && (
        <>
          <h3 className="works-section-title" style={{ marginTop: 12 }}>申請（新しい順に 10 件まで）</h3>
          <LeaveRequestList items={reqs} admin onChanged={load} onPrint={(r) => setPrint(r)} />
        </>
      )}
      <p className="ui-note">
        休暇の申請・登録は、カレンダーの日を押して「＋ 休暇を申請する」から。取得日の取り消しや期間ごとの履歴は <Link to="/leave">有給休暇の管理</Link> で見られます。
      </p>
      {print && <LeaveSheet request={print} name={staff.name} onClose={() => setPrint(null)} />}
    </section>
  )
}
