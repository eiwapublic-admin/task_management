import { useCallback, useEffect, useState } from 'react'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import ConfirmDeleteButton from '../components/ConfirmDeleteButton'
import {
  fetchBilmenMailSettings,
  updateBilmenMailSettings,
  fetchBilmenMailRecipients,
  createBilmenMailRecipient,
  updateBilmenMailRecipient,
  deleteBilmenMailRecipient,
} from '../lib/bilmen'
import './Dashboard.css'
import './Bilmen.css'

const EMPTY_RECIPIENT = { name: '', email: '', note: '', disabled: false }

// テナントへのメール設定（文面・宛先）。docs/bilmen-plan.md 7-3・13-19。
// 外部に出る操作の一部のため owner・備品出庫限定ロールには画面ごと見せない（App.jsx で
// RequireStaff を掛けているが、API側（worker/lib/bilmen.js）でも同じ判定を持つ）。
// 現行の雛形は1本のみのため複数テンプレート管理はせず、件名・本文だけの単純な設定にした。
export default function BilmenMail() {
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [savingSettings, setSavingSettings] = useState(false)
  const [recipients, setRecipients] = useState([])
  const [drafts, setDrafts] = useState({}) // id -> 編集中の値（保存前）
  const [newRecipient, setNewRecipient] = useState(EMPTY_RECIPIENT)
  const [adding, setAdding] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [settings, recipientRows] = await Promise.all([fetchBilmenMailSettings(), fetchBilmenMailRecipients()])
      setSubject(settings.subject)
      setBody(settings.body)
      setRecipients(recipientRows)
      setDrafts({})
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function handleSaveSettings() {
    setSavingSettings(true)
    setError('')
    setInfo('')
    try {
      await updateBilmenMailSettings({ subject, body })
      setInfo('文面を保存しました。')
    } catch (err) {
      setError(err.message)
    } finally {
      setSavingSettings(false)
    }
  }

  function draftFor(r) {
    return drafts[r.id] || { name: r.name, email: r.email, note: r.note || '', disabled: r.disabled }
  }

  function updateDraft(id, patch) {
    setDrafts((prev) => {
      const base = prev[id] || draftFor(recipients.find((r) => r.id === id))
      return { ...prev, [id]: { ...base, ...patch } }
    })
  }

  async function handleSaveRecipient(id) {
    setError('')
    try {
      const saved = await updateBilmenMailRecipient(id, draftFor(recipients.find((r) => r.id === id)))
      setRecipients((prev) => prev.map((r) => (r.id === id ? saved : r)))
      setDrafts((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleDeleteRecipient(id) {
    setError('')
    try {
      await deleteBilmenMailRecipient(id)
      setRecipients((prev) => prev.filter((r) => r.id !== id))
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleAddRecipient() {
    if (!newRecipient.name.trim() || !newRecipient.email.trim()) {
      setError('宛先名とメールアドレスは必須です')
      return
    }
    setAdding(true)
    setError('')
    try {
      const created = await createBilmenMailRecipient(newRecipient)
      setRecipients((prev) => [...prev, created])
      setNewRecipient(EMPTY_RECIPIENT)
    } catch (err) {
      setError(err.message)
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-wide app-scroll">
        <FeatureHeader />

        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}
        {info && <p className="dashboard-banner">{info}</p>}

        {loading ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : (
          <>
            <section className="bilmen-fieldset">
              <h2 className="ui-page-title">案内メールの文面</h2>
              <p className="ui-note">
                使える変数: <code>%対象年月%</code>（例: 2026年9月度）／ <code>%建物名%</code>／{' '}
                <code>%作業件数%</code>（報知対象の件数）
              </p>
              <div className="ui-field">
                <label>件名</label>
                <input className="ui-input" value={subject} onChange={(e) => setSubject(e.target.value)} />
              </div>
              <div className="ui-field">
                <label>本文</label>
                <textarea className="ui-textarea" rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
              </div>
              <button type="button" className="btn-primary" onClick={handleSaveSettings} disabled={savingSettings}>
                {savingSettings ? '保存中…' : '文面を保存'}
              </button>
            </section>

            <section className="bilmen-fieldset">
              <h2 className="ui-page-title">宛先</h2>
              <div className="ui-table-wrap">
                <table className="ui-table bilmen-mail-recipients-table">
                  <thead>
                    <tr>
                      <th>宛先名</th>
                      <th>メールアドレス</th>
                      <th>備考</th>
                      <th>有効</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {recipients.map((r) => {
                      const draft = draftFor(r)
                      const dirty = Boolean(drafts[r.id])
                      return (
                        <tr key={r.id} className={r.disabled ? 'is-disabled' : ''}>
                          <td>
                            <input
                              className="ui-input is-compact"
                              value={draft.name}
                              onChange={(e) => updateDraft(r.id, { name: e.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              className="ui-input is-compact"
                              value={draft.email}
                              onChange={(e) => updateDraft(r.id, { email: e.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              className="ui-input is-compact"
                              value={draft.note}
                              onChange={(e) => updateDraft(r.id, { note: e.target.value })}
                            />
                          </td>
                          <td className="bilmen-check-cell">
                            <input
                              type="checkbox"
                              checked={!draft.disabled}
                              onChange={(e) => updateDraft(r.id, { disabled: !e.target.checked })}
                              aria-label={`${r.name} を有効にする`}
                            />
                          </td>
                          <td>
                            <div className="bilmen-generate-actions">
                              {dirty && (
                                <button type="button" className="btn-plain" onClick={() => handleSaveRecipient(r.id)}>
                                  保存
                                </button>
                              )}
                              <ConfirmDeleteButton
                                label={`${r.name} を削除`}
                                onConfirm={() => handleDeleteRecipient(r.id)}
                              />
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                    <tr>
                      <td>
                        <input
                          className="ui-input is-compact"
                          value={newRecipient.name}
                          placeholder="宛先名"
                          onChange={(e) => setNewRecipient((prev) => ({ ...prev, name: e.target.value }))}
                        />
                      </td>
                      <td>
                        <input
                          className="ui-input is-compact"
                          value={newRecipient.email}
                          placeholder="メールアドレス"
                          onChange={(e) => setNewRecipient((prev) => ({ ...prev, email: e.target.value }))}
                        />
                      </td>
                      <td>
                        <input
                          className="ui-input is-compact"
                          value={newRecipient.note}
                          placeholder="備考"
                          onChange={(e) => setNewRecipient((prev) => ({ ...prev, note: e.target.value }))}
                        />
                      </td>
                      <td />
                      <td>
                        <button type="button" className="btn-primary" onClick={handleAddRecipient} disabled={adding}>
                          {adding ? '追加中…' : '←追加'}
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  )
}
