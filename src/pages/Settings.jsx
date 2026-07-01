import { useNavigate } from 'react-router-dom'
import { useState } from 'react'
import SettingsPanel from '../components/SettingsPanel'
import './Dashboard.css'

const MOCK_SETTINGS = {
  fetch_interval_minutes: 30,
  assignees: ['担当者A', '担当者B', '担当者C'],
  business_keywords: '',
}

export default function Settings() {
  const navigate = useNavigate()
  const [saved, setSaved] = useState(false)

  function handleSave(values) {
    // Phase 1: ダミー実装。Supabase settings テーブルへの保存は Phase 2/3 で接続する。
    console.log('settings saved (mock):', values)
    setSaved(true)
  }

  return (
    <div className="dashboard-page">
      <header className="dashboard-header">
        <h1>設定</h1>
        <div className="dashboard-header-right">
          <button onClick={() => navigate('/')}>カンバンに戻る</button>
        </div>
      </header>
      <div style={{ padding: '16px 24px', maxWidth: 480 }}>
        <SettingsPanel settings={MOCK_SETTINGS} onSave={handleSave} />
        {saved && <p style={{ color: '#2563eb', fontSize: 13 }}>保存しました（ダミー）</p>}
      </div>
    </div>
  )
}
