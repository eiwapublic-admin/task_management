import { useState } from 'react'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import { saveEquipmentCategories } from '../lib/equipment'

// カテゴリの一覧・追加・編集（5-6）。件数が少ないため専用画面ではなくモーダルで扱う。
export default function EquipmentCategoryForm({ categories, onClose, onSaved }) {
  useBodyScrollLock()

  const [rows, setRows] = useState(
    categories.map((c) => ({ code: c.code, name: c.name, sort_order: c.sort_order, note: c.note || '' }))
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function updateRow(i, patch) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  function addRow() {
    setRows((prev) => [...prev, { code: '', name: '', sort_order: (prev.length + 1) * 10, note: '' }])
  }

  async function handleSave() {
    setError('')
    const valid = rows.filter((r) => r.code.trim() && r.name.trim())
    if (valid.length === 0) return setError('コードと名称は必須です')
    setSaving(true)
    try {
      await saveEquipmentCategories(valid)
      onSaved()
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <div className="ui-overlay is-nested" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="ui-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h3 className="ui-modal-title">カテゴリの設定</h3>
          <button type="button" className="icon-btn-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>

        <div className="ui-modal-body is-stacked">
          {error && (
            <p className="dashboard-error dashboard-banner" role="alert">
              {error}
            </p>
          )}

          <div className="ui-table-wrap">
            <table className="ui-table">
              <thead>
                <tr>
                  <th>コード</th>
                  <th>名称</th>
                  <th className="is-numeric">表示順</th>
                  <th>備考</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        type="text"
                        className="ui-input is-compact"
                        value={r.code}
                        onChange={(e) => updateRow(i, { code: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        className="ui-input is-compact"
                        value={r.name}
                        onChange={(e) => updateRow(i, { name: e.target.value })}
                      />
                    </td>
                    <td className="is-numeric">
                      <input
                        type="number"
                        className="ui-input is-compact"
                        inputMode="numeric"
                        value={r.sort_order}
                        onChange={(e) => updateRow(i, { sort_order: Number(e.target.value) || 99 })}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        className="ui-input is-compact"
                        value={r.note}
                        onChange={(e) => updateRow(i, { note: e.target.value })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button type="button" className="btn-plain" onClick={addRow}>
            カテゴリを追加
          </button>
          <p className="ui-note">削除は現状このモーダルからはできません（備品から参照されている可能性があるため）。</p>
        </div>

        <div className="ui-modal-foot">
          <div className="ui-modal-foot-start" />
          <div className="ui-modal-foot-end">
            <button type="button" className="btn-plain" onClick={onClose}>
              キャンセル
            </button>
            <button type="button" className="btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? '保存中…' : '保存する'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
