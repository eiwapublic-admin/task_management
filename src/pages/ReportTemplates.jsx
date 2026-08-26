import { useEffect, useState } from 'react'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import { fetchTemplates, saveTemplates } from '../lib/reports'
import './Dashboard.css'

// 定型文（ルーチン業務の文言）の設定。現行 FileMaker の「特記事項設定」に相当する。
// 設定の担当者名と同じく、改行区切りの1つのテキストエリアで編集する方式に揃えた。
export default function ReportTemplates() {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    fetchTemplates()
      .then((list) => setText(list.map((t) => t.label).join('\n')))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  async function handleSave() {
    setSaving(true)
    setMessage('')
    setError('')
    try {
      const labels = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      const res = await saveTemplates(labels)
      setMessage(`保存しました（${res.count} 件）`)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-narrow reports-container app-scroll">
        <FeatureHeader
          actions={
            <>
              {message && <span className="report-saved">{message}</span>}
              <button type="button" className="btn-primary" onClick={handleSave} disabled={saving || loading}>
                {saving ? '保存中…' : '保存'}
              </button>
            </>
          }
        />

        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}

        <section className="report-card">
          <p className="settings-hint">
            日報の作業記録で「定型文から追加」に並ぶ文言です。1行に1つ書いてください。
            並べた順にボタンが表示されます。
          </p>
          {loading ? (
            <p className="dashboard-loading">読み込み中…</p>
          ) : (
            <textarea
              className="template-textarea"
              value={text}
              rows={16}
              placeholder={'残留塩素測定を実施しました。\n共用部の定期清掃を行いました。\nゴミ搬出を行いました。'}
              onChange={(e) => setText(e.target.value)}
              aria-label="定型文（1行に1つ）"
            />
          )}
        </section>
      </div>
    </div>
  )
}
