import { useEffect, useState } from 'react'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import { fetchBilmenMonthlyNote, saveBilmenMonthlyNote, formatRevisionLabel } from '../lib/bilmen'

// 注釈と変更表記のモーダル（docs/bilmen-plan.md 5-4。2026-09-09〜）。対象月の
// 「注釈」と「変更日付」を編集する小さなモーダル。
//
//   注釈     … 連絡票PDFの大見出し直下・作業リストの上に1回だけ出る月固有の但し書き（8-2）
//   変更日付 … 一度掲示・報知した後に差し替え版を出すときの日付（2026-09-15〜）。
//              入れると日程表・連絡票のタイトル右に赤字で「（yyyy/mm/dd 変更版）」が出る
//
// **両方を空にして保存すると行ごと削除**され、一覧のボタンは未登録（中立色）に戻る。
// 注釈なしで変更日付だけ、という使い方もできる（文面は変えずに版だけ改める場合）。
export default function BilmenMonthlyNoteModal({ month, onClose, onSaved }) {
  useBodyScrollLock()

  const [note, setNote] = useState('')
  const [revisedOn, setRevisedOn] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    fetchBilmenMonthlyNote(month)
      .then((v) => {
        if (!active) return
        setNote(v.note)
        setRevisedOn(v.revised_on)
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
      const saved = await saveBilmenMonthlyNote(month, { note, revised_on: revisedOn })
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
          <h3 className="ui-modal-title">{month.replace('-', '年')}月の注釈と変更表記</h3>
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
            連絡票PDFの見出し直下に、作業リストより目立つ形で表示されます（従来版は赤字、カード版は琥珀色の枠付き）。
            両方とも空のまま保存すると消えます。
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
          <label className="ui-field">
            <span>変更日付（差し替え版を出すとき）</span>
            <input
              type="date"
              className="ui-input"
              value={revisedOn}
              disabled={loading}
              onChange={(e) => setRevisedOn(e.target.value)}
            />
          </label>
          <p className="ui-note">
            {revisedOn ? (
              <>
                日程表・連絡票のタイトル右に、赤字で
                <strong className="bilmen-revision-preview">{formatRevisionLabel(revisedOn)}</strong>
                と入ります。
              </>
            ) : (
              '一度掲示・報知した後に差し替え版を出すときだけ入れてください。空欄なら何も出ません（初版）。'
            )}
          </p>
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
