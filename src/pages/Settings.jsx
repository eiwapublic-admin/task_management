import { useEffect, useState } from 'react'
import AppHeader from '../components/AppHeader'
import SettingsPanel from '../components/SettingsPanel'
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
  const [settings, setSettings] = useState(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    fetchSettings()
      .then((s) =>
        setSettings({
          fetch_interval_minutes: Number(s.fetch_interval_minutes) || 30,
          active_hours_start: Number.isFinite(Number(s.active_hours_start))
            ? Number(s.active_hours_start)
            : 8,
          active_hours_end: Number.isFinite(Number(s.active_hours_end))
            ? Number(s.active_hours_end)
            : 18,
          archive_after_days: Number.isFinite(Number(s.archive_after_days))
            ? Number(s.archive_after_days)
            : 30,
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
    <div className="dashboard-page settings-page">
      <AppHeader />
      <div className="settings-container">
        <div className="settings-toolbar">
          <h2 className="page-title">設定</h2>
          <span className="settings-saved" role="status" aria-live="polite">
            {status}
          </span>
          <button className="btn-save" type="submit" form="settings-form">
            保存
          </button>
        </div>
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
      </div>
    </div>
  )
}
