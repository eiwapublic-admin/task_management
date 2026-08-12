import { useEffect, useMemo, useState } from 'react'
import ConfirmDeleteButton from './ConfirmDeleteButton'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import { toDateTimeLocal } from '../lib/reports'
import {
  EQUIPMENT_OUT_REASONS,
  createEquipmentTransaction,
  updateEquipmentTransaction,
  fetchEquipmentSuggest,
} from '../lib/equipment'

// 出庫・設置モーダル（5-4）。Phase 1 は共用部設置／不良品処分のみ
// （テナント設置・新規入替・署名は Phase 2 で追加。docs/equipment-plan.md 5-4・11章）。
// existing を渡すと編集モード（履歴画面の行タップから開く）になる
export default function EquipmentOutForm({ items, existing, onClose, onSaved, onDelete }) {
  useBodyScrollLock()

  const trackedItems = useMemo(() => items.filter((i) => !i.disabled || i.id === existing?.item_id), [items, existing])
  const [itemId, setItemId] = useState(existing?.item_id || trackedItems[0]?.id || '')
  const [reason, setReason] = useState(existing?.reason || 'common')
  const [occurredAt, setOccurredAt] = useState(() => toDateTimeLocal(existing?.occurred_at))
  const [location, setLocation] = useState(existing?.location || '')
  const [locationOptions, setLocationOptions] = useState([])
  const [quantity, setQuantity] = useState(existing ? String(existing.quantity) : '')
  const [staffName, setStaffName] = useState(existing?.staff_name || '')
  const [staffOptions, setStaffOptions] = useState([])
  const [note, setNote] = useState(existing?.note || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchEquipmentSuggest('location').then(setLocationOptions).catch(() => {})
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
  const afterQty = beforeQty !== null && Number.isFinite(numericQty) ? beforeQty - numericQty : null

  async function handleSave() {
    setError('')
    if (!itemId) return setError('備品を選択してください')
    if (!Number.isFinite(numericQty) || numericQty <= 0) return setError('出庫数量を入力してください')

    setSaving(true)
    try {
      const payload = {
        reason,
        occurred_at: occurredAt ? new Date(occurredAt).toISOString() : new Date().toISOString(),
        location: reason === 'common' ? location || null : null,
        staff_name: staffName || null,
        note: note || null,
        quantity: numericQty,
      }
      const saved = existing
        ? await updateEquipmentTransaction(existing.id, payload)
        : await createEquipmentTransaction({ item_id: itemId, kind: 'out', ...payload })
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
          <h3 className="ui-modal-title">{existing ? '出庫・設置記録の修正' : '出庫・設置記録'}</h3>
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
            <span>出庫理由</span>
            <div className="equipment-reason-toggle" role="group" aria-label="出庫理由">
              {EQUIPMENT_OUT_REASONS.map((r) => (
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
            <p className="ui-note">
              テナント設置・新規入替は次のフェーズで対応予定です。それまでは備考にテナント名等を記載してください。
            </p>
          </div>

          <label className="ui-field">
            <span>出庫日時</span>
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

          {reason === 'common' && (
            <label className="ui-field">
              <span>設置場所</span>
              <input
                type="text"
                className="ui-input"
                list="equipment-location-options"
                placeholder="喫煙室 / 通路 / 玄関ホール"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
              <datalist id="equipment-location-options">
                {locationOptions.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            </label>
          )}

          <label className="ui-field">
            <span>出庫数量</span>
            <input
              type="number"
              className="ui-input"
              inputMode="numeric"
              min="1"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </label>

          {!existing && beforeQty !== null && (
            <p className={`ui-note${afterQty !== null && afterQty < 0 ? ' is-danger' : ''}`}>
              在庫の変化: {beforeQty} → {afterQty !== null ? afterQty : '?'}
              {afterQty !== null && afterQty < 0 && '（在庫がマイナスになります）'}
            </p>
          )}

          <label className="ui-field">
            <span>担当者</span>
            <input
              type="text"
              className="ui-input"
              list="equipment-staff-options"
              value={staffName}
              onChange={(e) => setStaffName(e.target.value)}
            />
            <datalist id="equipment-staff-options">
              {staffOptions.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </label>

          <label className="ui-field">
            <span>備考</span>
            <textarea className="ui-textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
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
