// 設定（現行: Parm）
import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import PushCard from '../components/PushCard.jsx'
import { formatBuildTime } from '../../lib/version.js'
import { reloadApp } from '../../pwa/reloadApp.js'

const RULES = [
  ['absent_min', '未出勤: 出勤予定から何分過ぎても出勤がないとき（管理者に通知）'],
  ['late_min', '遅刻: 出勤が予定より何分を超えて遅いとき'],
  ['early_min', '早退: 退勤が予定より何分を超えて早いとき'],
  ['no_out_min', '退勤漏れ: 退勤予定から何分過ぎても退勤がないとき（本人に通知）'],
  ['overtime_min', '超過: 退勤が予定より何分を超えて遅いとき'],
]
const DEFAULT_RULES = { absent_min: 10, late_min: 5, early_min: 5, no_out_min: 60, overtime_min: 30 }

export default function Settings() {
  const [v, setV] = useState(null)
  const [holidayText, setHolidayText] = useState('')
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [staff, setStaff] = useState([])
  useEffect(() => {
    api('/api/works/staff')
      .then((d) => setStaff(d.items.filter((s) => s.status !== 'retired')))
      .catch(() => {})
  }, [])
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
      const alert_rules = Object.fromEntries(RULES.map(([k]) => [k, Number(v.alert_rules?.[k] ?? DEFAULT_RULES[k])]))
      const { settings } = await api('/api/works/settings', { method: 'PUT', body: { ...v, company_holidays, alert_rules } })
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
        <div className="ui-card-title">労務管理者</div>
        <p className="ui-note" style={{ marginTop: 0 }}>
          休暇の申請を承認・却下できる人です（複数名可）。申請が来るとこの人たちに通知します。自分の申請は、ほかの労務管理者が承認します。だれも選ばないときは、eWorks の管理者全員が承認できます。※ アプリの管理者（ログインして管理画面を使える人）である必要があります。
        </p>
        <div className="works-check-list">
          {staff.map((s) => {
            const ids = v.labor_manager_ids || []
            const on = ids.includes(s.id)
            return (
              <label key={s.id} className={`works-check-item ${on ? 'is-on' : ''}`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => setV({ ...v, labor_manager_ids: on ? ids.filter((x) => x !== s.id) : [...ids, s.id] })}
                />
                <strong>{s.name}</strong>
                <span className="works-muted">{s.code}</span>
                {!s.user_id && <span className="works-muted">（アプリ未登録）</span>}
              </label>
            )
          })}
        </div>
      </div>
      <div className="ui-card" style={{ marginTop: 12 }}>
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
        <div className="ui-card-title">要確認</div>
        <p className="ui-note" style={{ marginTop: 0 }}>未出勤・退勤漏れは、入力方法が「QR」でアプリに登録済みのスタッフだけを見ます。位置の不一致は、現場の緯度・経度を登録した現場だけで判定します（許容距離は現場ごと。既定 300m）。</p>
        <div className="works-grid-2">
          {RULES.map(([k, label]) => (
            <label key={k} className="ui-field">
              <span>{label}</span>
              <input className="ui-input" inputMode="numeric" value={v.alert_rules?.[k] ?? DEFAULT_RULES[k]} onChange={(e) => setV({ ...v, alert_rules: { ...DEFAULT_RULES, ...v.alert_rules, [k]: e.target.value } })} />
            </label>
          ))}
          <label className="ui-field">
            <span>要確認を出し始める日（これより前の日は出しません）</span>
            <input className="ui-input" type="date" value={v.alerts_from || ''} onChange={(e) => setV({ ...v, alerts_from: e.target.value })} />
          </label>
        </div>
      </div>
      <div className="ui-card" style={{ marginTop: 12 }}>
        <div className="ui-card-title">会社の休日（年末年始など）</div>
        <p className="ui-note" style={{ marginTop: 0 }}>タスク管理の日報カレンダーで「休館日」にした日は、自動で会社の休日になります（ここに入れる必要はありません）。それ以外に休みにしたい日だけ、1 行に 1 日、2026-12-30 の形で入力します。国民の祝日も入力は不要です。</p>
        <textarea className="ui-textarea" rows={6} value={holidayText} onChange={(e) => setHolidayText(e.target.value)} />
      </div>
      {error && <p className="works-error">{error}</p>}
      <div className="works-row-actions" style={{ marginTop: 12 }}>
        <button type="button" className="btn-primary works-btn-accent" onClick={save}>保存</button>
        {msg && <span className="works-muted">{msg}</span>}
      </div>
      <PushCard admin />
      {/* 版の表示と「最新に更新」（ホームを廃止したのでここへ。2026-11-24） */}
      <div className="ui-card" style={{ marginTop: 12 }}>
        <div className="ui-card-title">アプリ</div>
        <div className="works-row-actions" style={{ marginBottom: 0 }}>
          <span className="works-muted">ver.{formatBuildTime()}</span>
          <button type="button" className="btn-plain" onClick={() => reloadApp({ to: '/settings' })}>最新に更新</button>
        </div>
      </div>
    </>
  )
}
