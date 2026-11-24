// ホーム。今日の状態と「出勤を記録」「退勤を記録」の大きなボタン、今日・明日の予定（docs/eworks-plan.md 6-2・10-3）
// 入力方法（2026-11-20）で切り替える: qr＝QR の大きなボタン／self＝時刻の入力欄と「予定通り」／proxy＝管理者が入力する旨の表示
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, WEEKDAYS } from '../lib/api.js'
import { dow, todayJst } from '../../../worker/lib/works/time.js'
import { formatBuildTime } from '../../lib/version.js'
import { reloadApp } from '../../pwa/reloadApp.js'
import { flushQueue, pendingCount } from '../lib/punch.js'
import ActualEditor from '../components/ActualEditor.jsx'
import AlertBanner from '../components/AlertBanner.jsx'

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

// QR の読み取り（ZXing）は打刻のときだけ読み込む
const PunchFlow = lazy(() => import('../components/PunchFlow.jsx'))

const STATE = { before: '未出勤', working: '勤務中', done: '退勤済み' }

export default function Home({ user }) {
  const today = todayJst()
  const tomorrow = addDays(today, 1)
  const [items, setItems] = useState(null)
  const [now, setNow] = useState(null)
  const [error, setError] = useState('')
  const [punch, setPunch] = useState(null)
  const [pending, setPending] = useState(pendingCount())

  const loadToday = useCallback(() => {
    if (!user?.staff) return
    api('/api/works/punch/today').then(setNow).catch((e) => setError(e.message))
  }, [user?.staff])

  useEffect(() => {
    if (!user?.staff) return
    const months = [...new Set([today.slice(0, 7), tomorrow.slice(0, 7)])]
    Promise.all(months.map((m) => api(`/api/works/shifts?month=${m}&staff_id=${user.staff.id}`)))
      .then((rs) => setItems(rs.flatMap((r) => r.items)))
      .catch((e) => setError(e.message))
    loadToday()
  }, [user?.staff, today, tomorrow, loadToday])

  // 電波が戻ったら、端末に保存した打刻を送る
  useEffect(() => {
    const flush = () =>
      flushQueue().then((n) => {
        setPending(pendingCount())
        if (n) loadToday()
      })
    flush()
    window.addEventListener('online', flush)
    return () => window.removeEventListener('online', flush)
  }, [loadToday])

  const label = (d) => `${Number(d.slice(5, 7))}月${Number(d.slice(8))}日（${WEEKDAYS[dow(d)]}）`
  const day = (d, title) => {
    const list = (items || []).filter((s) => s.work_date === d)
    const actual = d === today ? now?.shifts || [] : []
    return (
      <div className={`ui-card ${d === today ? 'works-today' : ''}`} style={{ marginBottom: 12 }}>
        <div className="ui-card-title">{title} {label(d)}</div>
        {items === null && !error && <p className="works-muted" style={{ margin: 0 }}>読み込み中…</p>}
        {items && list.length === 0 && <p className="works-muted" style={{ margin: 0 }}>予定はありません</p>}
        {list.map((s) => {
          const a = actual.find((x) => x.id === s.id)
          return (
            <p key={s.id} style={{ margin: '4px 0' }}>
              <strong>{s.plan_start}〜{s.plan_end}</strong>　{s.telework ? <span className="works-tw-badge">テレワーク</span> : s.site ? s.site.name : ''}
              {a?.actual_start && (
                <span className="works-actual">
                  　記録 <span className={a.actual_start !== s.plan_start ? 'works-diff' : ''}>{a.actual_start}</span>〜
                  {a.actual_end && <span className={a.actual_end !== s.plan_end ? 'works-diff' : ''}>{a.actual_end}</span>}
                </span>
              )}
            </p>
          )
        })}
      </div>
    )
  }

  const next = now?.state === 'working' ? 'out' : 'in'
  // 今日の予定がテレワークだけなら、QR を使わず自己申告で記録する
  const telework = !!now?.shifts?.length && now.shifts.every((s) => s.telework)
  const method = user?.staff?.punch_method || 'qr'

  return (
    <>
      <h1 className="works-title">ホーム</h1>
      <p style={{ marginTop: 0 }}>{user?.staff ? `${user.staff.name} さん` : user?.display_name ? `${user.display_name} さん` : ''}</p>
      {user?.works_admin && <AlertBanner />}
      {user?.staff ? (
        <>
          {method === 'self' && (
            <div className="works-punch-card">
              <div className="works-punch-state">今日の出勤・退勤の時刻を入力してください</div>
              {now && now.shifts.length === 0 && <p className="works-muted" style={{ margin: 0 }}>今日の予定はありません。</p>}
              {now?.shifts.map((s) => (
                <div key={s.id}>
                  <div className="works-muted" style={{ marginBottom: 4 }}>
                    予定 {s.plan_start}〜{s.plan_end}{s.telework ? '（テレワーク）' : s.site ? `　${s.site.name}` : ''}
                  </div>
                  <ActualEditor shift={s} onSaved={loadToday} />
                </div>
              ))}
              <p className="ui-note" style={{ margin: 0 }}>ほかの日の入力や 1 か月分をまとめて「予定通り」にするのは <Link to="/calendar">カレンダー</Link> からできます。</p>
            </div>
          )}
          {method === 'proxy' && (
            <div className="works-punch-card">
              <div className="works-punch-state">出勤・退勤の時刻は、出勤簿をもとに管理者が入力します。</div>
            </div>
          )}
          {method === 'qr' && (
          <div className="works-punch-card">
            <div className="works-punch-state">
              今日の状態: <strong className={`is-${now?.state || 'before'}`}>{now ? STATE[now.state] : '…'}</strong>
              {now?.punches?.length > 0 && (
                <span className="works-muted">
                  （{now.punches.map((p) => `${p.kind === 'in' ? '出勤' : '退勤'} ${p.time}`).join('・')}）
                </span>
              )}
            </div>
            {telework && <div className="works-telework">テレワーク：ボタンを押した時刻を自己申告として記録します（QR は不要です）</div>}
            <button type="button" className={`works-punch-btn is-${next}`} onClick={() => setPunch(next)}>
              {next === 'in' ? '出勤を記録' : '退勤を記録'}
            </button>
            {now?.state === 'done' && (
              <button type="button" className="btn-plain" onClick={() => setPunch('out')}>退勤を記録し直す</button>
            )}
            {pending > 0 && <p className="works-punch-flags">電波が戻るのを待っている記録が {pending} 件あります（自動で送ります）</p>}
            {!telework && <p className="ui-note" style={{ margin: 0 }}>記録のときに位置情報を記録します（QR の持ち出しを防ぐため）。</p>}
          </div>
          )}
          {day(today, '今日')}
          {day(tomorrow, '明日')}
          <p className="ui-note">月の予定は <Link to="/calendar">カレンダー</Link> で見られます。</p>
        </>
      ) : (
        <p className="works-muted">スタッフ情報が紐づいていないため、予定は表示されません。</p>
      )}
      {error && <p className="works-error">{error}</p>}
      {punch && (
        <Suspense fallback={<div className="works-punch"><p className="works-punch-lead">準備しています…</p></div>}>
        <PunchFlow
          expected={punch}
          telework={telework}
          onClose={() => setPunch(null)}
          onDone={() => {
            setPending(pendingCount())
            loadToday()
          }}
        />
        </Suspense>
      )}
      <div className="works-version">
        ver.{formatBuildTime()}
        <button type="button" className="btn-plain" onClick={() => reloadApp({ to: '/' })}>最新に更新</button>
      </div>
    </>
  )
}
