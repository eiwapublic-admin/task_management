import { useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import SettingsPanel from '../components/SettingsPanel'
import UsagePanel from '../components/UsagePanel'
import { fetchSettings } from '../lib/tasks'
import { saveSettings } from '../lib/api'
import './Dashboard.css'

const DEFAULT_ASSIGNEES = ['橋口', '西川', '岡田']

function parseAssignees(raw) {
  if (!raw) return DEFAULT_ASSIGNEES
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) && arr.length > 0 ? arr : DEFAULT_ASSIGNEES
  } catch {
    return DEFAULT_ASSIGNEES
  }
}

export default function Settings() {
  const navigate = useNavigate()
  const [settings, setSettings] = useState(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    fetchSettings()
      .then((s) =>
        setSettings({
          fetch_interval_minutes: Number(s.fetch_interval_minutes) || 30,
          assignees: parseAssignees(s.assignees),
          business_keywords: s.business_keywords || '',
          org_context: s.org_context || '',
        })
      )
      .catch((err) => setError(err.message))
  }, [])

  async function handleSave(values) {
    setStatus('')
    setError('')
    try {
      await saveSettings(values)
      setStatus('保存しました')
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="dashboard-page">
      <header className="dashboard-header">
        <h1>設定</h1>
        <div className="dashboard-header-right">
          <button onClick={() => navigate('/')}>カンバンに戻る</button>
        </div>
      </header>
      <div className="settings-container">
        {error && (
          <p className="dashboard-banner dashboard-error" role="alert">
            {error}
          </p>
        )}
        {settings ? (
          <SettingsPanel settings={settings} onSave={handleSave} />
        ) : (
          !error && <p className="dashboard-loading">読み込み中…</p>
        )}
        <p className="settings-saved" role="status" aria-live="polite">
          {status}
        </p>
        <UsagePanel />
      </div>
    </div>
  )
}
