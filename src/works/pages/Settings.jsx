// 設定（現行: Parm）
import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

export default function Settings() {
  const [v, setV] = useState(null)
  const [holidayText, setHolidayText] = useState('')
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  useEffect(() => {
    api('/api/works/settings')
      .then(({ settings }) => {
        setV(settings)
        setHolidayText((settings.company_holidays || []).join('\n'))
      })
      .catch((e) => setError(e.message))
  }, [])
  if (!v) return <><h1 className="works-title">設定</h1>{error ? <p className="works-error">{error}</p> : <p className="works-muted">読み込み中…</p>}</>

  const setWin = (i, k, val) => setV({ ...v, break_windows: v.break_windows.map((w, j) => (j === i ? { ...w, [k]: val } : w)) })
  const save = async () => {
    setError('')
    setMsg('')
    try {
      const company_holidays = holidayText.split(/[\s,、]+/).map((s) => s.trim().replace(/\//g, '-')).filter(Boolean)
      const { settings } = await api('/api/works/settings', { method: 'PUT', body: { ...v, company_holidays } })
      setV(settings)
      setHolidayText(settings.company_holidays.join('\n'))
      setMsg('保存しました')
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <>
      <h1 className="works-title">設定</h1>
      <div className="ui-card">
        <div className="ui-card-title">休憩</div>
        <p className="ui-note" style={{ marginTop: 0 }}>勤務がこの時間帯をまたぐとき（開始より前に始まり、終了より後に終わる）だけ休憩を差し引きます。スタッフごとの例外は勤務体系で設定します。</p>
        {v.break_windows.map((w, i) => (
          <div key={i} className="works-row-actions">
            <input className="ui-input" style={{ width: 'auto' }} type="time" value={w.start} onChange={(e) => setWin(i, 'start', e.target.value)} />
            〜
            <input className="ui-input" style={{ width: 'auto' }} type="time" value={w.end} onChange={(e) => setWin(i, 'end', e.target.value)} />
            <button type="button" className="btn-plain" onClick={() => setV({ ...v, break_windows: v.break_windows.filter((_, j) => j !== i) })}>削除</button>
          </div>
        ))}
        <button type="button" className="btn-plain" onClick={() => setV({ ...v, break_windows: [...v.break_windows, { start: '12:00', end: '13:00' }] })}>＋ 休憩時間帯を追加</button>
      </div>
      <div className="ui-card" style={{ marginTop: 12 }}>
        <div className="ui-card-title">打刻と予定</div>
        <div className="works-grid-2">
          <label className="ui-field">
            <span>打刻の丸め単位（出勤は切り上げ・退勤は切り捨て）</span>
            <select className="ui-select" value={v.rounding_minutes} onChange={(e) => setV({ ...v, rounding_minutes: Number(e.target.value) })}>
              {[1, 5, 10, 15, 30, 60].map((n) => <option key={n} value={n}>{n} 分</option>)}
            </select>
          </label>
          <label className="ui-field">
            <span>翌月の予定を作る日（毎月）</span>
            <input className="ui-input" inputMode="numeric" value={v.schedule_create_day} onChange={(e) => setV({ ...v, schedule_create_day: e.target.value })} />
          </label>
          <label className="ui-field">
            <span>招待リンクの有効日数</span>
            <input className="ui-input" inputMode="numeric" value={v.invite_valid_days} onChange={(e) => setV({ ...v, invite_valid_days: e.target.value })} />
          </label>
        </div>
      </div>
      <div className="ui-card" style={{ marginTop: 12 }}>
        <div className="ui-card-title">会社の休日（年末年始など）</div>
        <p className="ui-note" style={{ marginTop: 0 }}>1 行に 1 日、2026-12-30 の形で入力します。国民の祝日はここには入れません（予定作成の段階で別に扱います）。</p>
        <textarea className="ui-textarea" rows={6} value={holidayText} onChange={(e) => setHolidayText(e.target.value)} />
      </div>
      {error && <p className="works-error">{error}</p>}
      <div className="works-row-actions" style={{ marginTop: 12 }}>
        <button type="button" className="btn-primary works-btn-accent" onClick={save}>保存</button>
        {msg && <span className="works-muted">{msg}</span>}
      </div>
    </>
  )
}
