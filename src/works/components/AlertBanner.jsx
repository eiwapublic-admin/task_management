// 管理者向けの「要確認 n 件」（ホーム・勤務表一覧の先頭。docs/eworks-plan.md 8-2）
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api.js'

export default function AlertBanner() {
  const [c, setC] = useState(null)
  useEffect(() => {
    const load = () => api('/api/works/alerts/count').then(setC).catch(() => {})
    load()
    window.addEventListener('works-alerts-changed', load)
    return () => window.removeEventListener('works-alerts-changed', load)
  }, [])
  if (!c) return null
  if (!c.open && !c.requests) {
    return <p className="ui-note" style={{ marginTop: 0 }}>要確認はありません（先月から今日まで）。</p>
  }
  return (
    <Link to={c.open ? '/alerts' : '/alerts?tab=requests'} className="works-alert-banner">
      <span>要確認 <strong>{c.open}</strong> 件{c.high ? `（うち未出勤 ${c.high} 件）` : ''}</span>
      {c.requests > 0 && <span>修正申請 <strong>{c.requests}</strong> 件</span>}
      <span className="works-muted" style={{ marginLeft: 'auto' }}>一覧を開く ›</span>
    </Link>
  )
}
