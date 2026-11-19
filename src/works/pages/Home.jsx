// ホーム。今日・明日の予定を出す（Phase 3 で出勤・退勤ボタンが入る）
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, WEEKDAYS } from '../lib/api.js'
import { dow, todayJst } from '../../../worker/lib/works/time.js'

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

export default function Home({ user }) {
  const today = todayJst()
  const tomorrow = addDays(today, 1)
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!user?.staff) return
    const months = [...new Set([today.slice(0, 7), tomorrow.slice(0, 7)])]
    Promise.all(months.map((m) => api(`/api/works/shifts?month=${m}&staff_id=${user.staff.id}`)))
      .then((rs) => setItems(rs.flatMap((r) => r.items)))
      .catch((e) => setError(e.message))
  }, [user?.staff, today, tomorrow])

  const label = (d) => `${Number(d.slice(5, 7))}月${Number(d.slice(8))}日（${WEEKDAYS[dow(d)]}）`
  const day = (d, title) => {
    const list = (items || []).filter((s) => s.work_date === d)
    return (
      <div className={`ui-card ${d === today ? 'works-today' : ''}`} style={{ marginBottom: 12 }}>
        <div className="ui-card-title">{title} {label(d)}</div>
        {items === null && !error && <p className="works-muted" style={{ margin: 0 }}>読み込み中…</p>}
        {items && list.length === 0 && <p className="works-muted" style={{ margin: 0 }}>予定はありません</p>}
        {list.map((s) => (
          <p key={s.id} style={{ margin: '4px 0' }}>
            <strong>{s.plan_start}〜{s.plan_end}</strong>　{s.site ? s.site.name : ''}
          </p>
        ))}
      </div>
    )
  }

  return (
    <>
      <h1 className="works-title">ホーム</h1>
      <p style={{ marginTop: 0 }}>{user?.staff ? `${user.staff.name} さん` : user?.display_name ? `${user.display_name} さん` : ''}</p>
      {user?.staff ? (
        <>
          {day(today, '今日')}
          {day(tomorrow, '明日')}
          <p className="ui-note">月の予定は <Link to="/calendar">カレンダー</Link> で見られます。出勤・退勤の記録は次の段階（Phase 3）でここに入ります。</p>
        </>
      ) : (
        <p className="works-muted">スタッフ情報が紐づいていないため、予定は表示されません。</p>
      )}
      {error && <p className="works-error">{error}</p>}
    </>
  )
}
