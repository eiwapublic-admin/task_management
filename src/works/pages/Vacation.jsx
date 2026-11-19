// 休暇（本人）。自分の有給休暇・特別休暇の残りと、申請（労務担当が承認）・申請書の印刷
import { useCallback, useEffect, useState } from 'react'
import { api, WEEKDAYS } from '../lib/api.js'
import LeaveRequestForm from '../components/LeaveRequestForm.jsx'
import LeaveRequestList from '../components/LeaveRequestList.jsx'
import LeaveSheet from '../components/LeaveSheet.jsx'

const ymd = (d) => (d ? d.replaceAll('-', '/') : '')
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}（${WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]}）`

export default function Vacation() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [form, setForm] = useState(false)
  const [print, setPrint] = useState(null)
  const load = useCallback(() => {
    api('/api/works/leave/mine')
      .then((d) => {
        setData(d)
        setError('')
      })
      .catch((e) => setError(e.message))
  }, [])
  useEffect(() => {
    load()
  }, [load])
  const p = data?.summary?.period

  return (
    <>
      <div className="works-sticky">
        <h1 className="works-title">休暇</h1>
        <div className="works-row-actions">
          <button type="button" className="btn-primary works-btn-accent" onClick={() => setForm(true)} disabled={!data}>＋ 休暇を申請する</button>
          <button type="button" className="btn-plain" onClick={() => setPrint({ request: null })} disabled={!data}>空欄の申請書を印刷</button>
        </div>
      </div>
      {error && <p className="works-error">{error}</p>}
      {!data && !error && <p className="works-muted">読み込み中…</p>}
      {data && (
        <>
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
                {(data.taken.paid.length > 0 || data.taken.special.length > 0) && (
                  <div className="works-leave-days" style={{ marginTop: 8 }}>
                    {data.taken.paid.map((d) => (
                      <span key={d} className={`works-leave-day ${data.taken.special.includes(d) ? 'is-special' : ''}`} style={{ paddingRight: 10 }}>
                        {md(d)}{data.taken.special.includes(d) ? ' 特休' : ''}
                      </span>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="works-muted">{data.summary.first_grant ? `最初の有給休暇は ${ymd(data.summary.first_grant)} に付与されます。` : '入社日が未登録のため、有給休暇を計算できません。労務担当にお問い合わせください。'}</div>
            )}
          </div>
          <h2 className="works-subtitle">申請</h2>
          <LeaveRequestList items={data.requests} onChanged={load} onPrint={(r) => setPrint({ request: r })} />
        </>
      )}
      {form && (
        <LeaveRequestForm
          summary={data?.summary}
          onClose={() => setForm(false)}
          onSaved={() => {
            setForm(false)
            load()
          }}
        />
      )}
      {print && <LeaveSheet request={print.request} name={data?.staff?.name} onClose={() => setPrint(null)} />}
    </>
  )
}
