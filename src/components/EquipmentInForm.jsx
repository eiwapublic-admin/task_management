import { useEffect, useMemo, useState } from 'react'
import ConfirmDeleteButton from './ConfirmDeleteButton'
import Combobox from './Combobox'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import { toDateTimeLocal } from '../lib/reports'
import {
  EQUIPMENT_IN_REASONS,
  createEquipmentTransaction,
  updateEquipmentTransaction,
  fetchEquipmentSuggest,
} from '../lib/equipment'

// 入庫モーダル（5-3）。現行の「入庫登録」に相当。
// existing を渡すと編集モード（履歴画面の行タップから開く）になる。
// defaultItemId を渡すと、その備品をあらかじめ選んだ状態で開く（在庫一覧の行の「入」ボタン等。
// 2026-08-18）。どちらも無ければ備品は空欄から選ばせる（ヘッダの「入庫」ボタンから開いた場合）
export default function EquipmentInForm({ items, existing, defaultItemId, onClose, onSaved, onDelete }) {
  useBodyScrollLock()

  const trackedItems = useMemo(() => items.filter((i) => !i.disabled || i.id === existing?.item_id), [items, existing])
  const [itemId, setItemId] = useState(existing?.item_id || defaultItemId || '')
  const [reason, setReason] = useState(existing?.reason || 'procure')
  const [occurredAt, setOccurredAt] = useState(() => toDateTimeLocal(existing?.occurred_at))
  const [supplier, setSupplier] = useState(existing?.supplier || '')
  const [supplierOptions, setSupplierOptions] = useState([])
  const [quantity, setQuantity] = useState(existing ? String(existing.quantity) : '')
  const [staffName, setStaffName] = useState(existing?.staff_name || '')
  const [staffOptions, setStaffOptions] = useState([])
  const [note, setNote] = useState(existing?.note || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchEquipmentSuggest('supplier').then(setSupplierOptions).catch(() => {})
    fetchEquipmentSuggest('staff').then(setStaffOptions).catch(() => {})
  }, [])

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const groups = useMemo(() => {
    const map = new Map()
    for (const item of trackedItems) {
      const key = item.category_code || ''
      if (!map.has(key)) map.set(key, { name: item.category_name || '（カテゴリ未設定）', rows: [] })
      map.get(key).rows.push(item)
    }
    return [...map.values()]
  }, [trackedItems])

  const selectedItem = trackedItems.find((i) => i.id === itemId)
  const beforeQty = selectedItem?.track_stock ? selectedItem.stock_qty ?? 0 : null
  const numericQty = quantity === '' ? null : Number(quantity)
  const afterQty = beforeQty !== null && Number.isFinite(numericQty) ? beforeQty + numericQty : null

  async function handleSave() {
    setError('')
    if (!itemId) return setError('備品を選択してください')
    if (!Number.isFinite(numericQty) || numericQty === 0) return setError('入庫数量を入力してください')
    if (numericQty < 0 && reason !== 'adjust') return setError('マイナスの数量は在庫調整のときだけ指定できます')

    setSaving(true)
    try {
      const payload = {
        reason,
        occurred_at: occurredAt ? new Date(occurredAt).toISOString() : new Date().toISOString(),
        quantity: numericQty,
        supplier: supplier || null,
        staff_name: staffName || null,
        note: note || null,
      }
      const saved = existing
        ? await updateEquipmentTransaction(existing.id, payload)
        : await createEquipmentTransaction({ item_id: itemId, kind: 'in', ...payload })
      onSaved(saved)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <div className="ui-overlay is-nested" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="ui-modal is-sm" onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h3 className="ui-modal-title">{existing ? '入庫の修正' : '入庫登録'}</h3>
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

          <div className="equipment-reason-field">
            <span>入庫理由</span>
            <div className="equipment-reason-toggle" role="group" aria-label="入庫理由">
              {EQUIPMENT_IN_REASONS.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  className={`btn-plain equipment-reason-btn${reason === r.key ? ' is-active' : ''}`}
                  aria-pressed={reason === r.key}
                  onClick={() => setReason(r.key)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          <label className="ui-field">
            <span>入庫日時</span>
            <input
              type="datetime-local"
              className="ui-input"
              value={occurredAt}
              onChange={(e) => setOccurredAt(e.target.value)}
            />
          </label>

          <label className="ui-field">
            <span>備品</span>
            <select
              className="ui-select"
              value={itemId}
              disabled={Boolean(existing)}
              onChange={(e) => setItemId(e.target.value)}
            >
              {!itemId && (
                <option value="" disabled>
                  選択してください
                </option>
              )}
              {groups.map((g) => (
                <optgroup key={g.name} label={g.name}>
                  {g.rows.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <div className="ui-field">
            <span>調達先</span>
            <Combobox value={supplier} onChange={setSupplier} options={supplierOptions} />
          </div>

          <div className="ui-field-row">
            <label className="ui-field">
              <span>入庫数量</span>
              <input
                type="number"
                className="ui-input"
                inputMode="numeric"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </label>

            <div className="ui-field">
              <span>担当者</span>
              <Combobox value={staffName} onChange={setStaffName} options={staffOptions} />
            </div>
          </div>

          {!existing && beforeQty !== null && (
            <p className="ui-note">
              在庫の変化: {beforeQty} → {afterQty !== null ? afterQty : '?'}
            </p>
          )}

          <label className="ui-field">
            <span>備考</span>
            <textarea
              className="ui-textarea is-compact"
              rows={1}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="在庫調整理由など"
            />
          </label>
        </div>

        <div className="ui-modal-foot">
          <div className="ui-modal-foot-start">
            {existing && <ConfirmDeleteButton onConfirm={() => onDelete(existing.id)} label="この記録を削除" size={22} />}
          </div>
          <div className="ui-modal-foot-end">
            <button type="button" className="btn-plain" onClick={onClose}>
              キャンセル
            </button>
            <button type="button" className="btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? '保存中…' : '記録する'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
