import { useEffect, useState } from 'react'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import { fetchBilmenMonthlyNote, saveBilmenMonthlyNote } from '../lib/bilmen'

// 今月の注釈モーダル（docs/bilmen-plan.md 5-4。2026-09-09〜）。対象月のテキストを
// 1つ編集するだけの小さなモーダル。連絡票PDFの大見出し直下・作業リストの上に
// 赤字・太字・中央揃えで表示される（8-2）。空欄で保存すると行ごと削除され、
// 一覧のボタンは未登録（中立色）に戻る。
export default function BilmenMonthlyNoteModal({ month, onClose, onSaved }) {
  useBodyScrollLock()

  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    fetchBilmenMonthlyNote(month)
      .then((n) => {
        if (active) setNote(n)
      })
      .catch((err) => {
        if (active) setError(err.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [month])

  async function handleSave() {
    setSaving(true)
    setError('')
    try {
      const saved = await saveBilmenMonthlyNote(month, note)
      onSaved(saved)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <div className="ui-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="ui-modal is-sm" onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h3 className="ui-modal-title">{month.replace('-', '年')}月の注釈</h3>
          <button type="button" className="icon-btn-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>
        <div className="ui-modal-body">
          {error && (
            <p className="dashboard-error dashboard-banner" role="alert">
              {error}
            </p>
          )}
          <p className="ui-note">
            連絡票PDFの見出し直下に赤字・太字・中央揃えで表示されます。空欄のまま保存すると消えます。
          </p>
          <label className="ui-field">
            <span>注釈</span>
            <textarea
              className="ui-textarea"
              rows={3}
              value={note}
              disabled={loading}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例: 机上消防訓練につきましては、改めて詳細を報知いたしますので…"
            />
          </label>
        </div>
        <div className="ui-modal-foot">
          <div className="ui-modal-foot-start" />
          <div className="ui-modal-foot-end">
            <button type="button" className="btn-plain" onClick={onClose}>
              キャンセル
            </button>
            <button type="button" className="btn-primary" onClick={handleSave} disabled={saving || loading}>
              {saving ? '保存中…' : '保存する'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
