import { useState } from 'react'
import ConfirmDeleteButton from './ConfirmDeleteButton'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import { createEquipmentItem, updateEquipmentItem, deleteEquipmentItem } from '../lib/equipment'

// 備品の追加・編集モーダル（5-6）
export default function EquipmentItemForm({ existing, categories, onClose, onSaved, onDeleted }) {
  useBodyScrollLock()

  const [itemNo, setItemNo] = useState(existing?.item_no ? String(existing.item_no) : '')
  const [categoryCode, setCategoryCode] = useState(existing?.category_code || categories[0]?.code || '')
  const [name, setName] = useState(existing?.name || '')
  const [shortName, setShortName] = useState(existing?.short_name || '')
  const [productCode, setProductCode] = useState(existing?.product_code || '')
  const [sortOrder, setSortOrder] = useState(existing?.sort_order != null ? String(existing.sort_order) : '99')
  const [warnQty, setWarnQty] = useState(existing?.warn_qty != null ? String(existing.warn_qty) : '')
  const [trackStock, setTrackStock] = useState(existing ? existing.track_stock : true)
  const [disabled, setDisabled] = useState(existing?.disabled || false)
  const [note, setNote] = useState(existing?.note || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSave() {
    setError('')
    if (!name.trim()) return setError('備品名は必須です')

    setSaving(true)
    try {
      const payload = {
        category_code: categoryCode || null,
        name: name.trim(),
        short_name: shortName.trim() || null,
        product_code: productCode || null,
        sort_order: Number(sortOrder) || 99,
        warn_qty: warnQty === '' ? null : Number(warnQty),
        track_stock: trackStock,
        disabled,
        note: note || null,
      }
      if (existing) {
        const saved = await updateEquipmentItem(existing.id, payload)
        onSaved(saved)
      } else {
        const saved = await createEquipmentItem({
          ...payload,
          item_no: itemNo === '' ? undefined : Number(itemNo),
        })
        onSaved(saved)
      }
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  async function handleDelete() {
    try {
      await deleteEquipmentItem(existing.id)
      onDeleted(existing.id)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="ui-overlay is-nested" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="ui-modal is-sm" onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h3 className="ui-modal-title">{existing ? '備品の編集' : '備品を追加'}</h3>
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

          {!existing && (
            <label className="ui-field">
              <span>備品ID（空欄なら自動採番）</span>
              <input
                type="number"
                className="ui-input"
                inputMode="numeric"
                value={itemNo}
                onChange={(e) => setItemNo(e.target.value)}
              />
            </label>
          )}

          <label className="ui-field">
            <span>カテゴリ</span>
            <select className="ui-select" value={categoryCode} onChange={(e) => setCategoryCode(e.target.value)}>
              <option value="">（未設定）</option>
              {categories.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label className="ui-field">
            <span>備品名</span>
            <input type="text" className="ui-input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <label className="ui-field">
            <span>略称</span>
            <input
              type="text"
              className="ui-input"
              placeholder="未入力なら備品名から自動生成（括弧書きの補足を除いた表記）"
              value={shortName}
              onChange={(e) => setShortName(e.target.value)}
            />
          </label>

          <label className="ui-field">
            <span>製品番号</span>
            <input
              type="text"
              className="ui-input"
              value={productCode}
              onChange={(e) => setProductCode(e.target.value)}
            />
          </label>

          <div className="report-fields">
            <label className="ui-field">
              <span>表示順</span>
              <input
                type="number"
                className="ui-input"
                inputMode="numeric"
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
              />
            </label>
            <label className="ui-field">
              <span>警告数量</span>
              <input
                type="number"
                className="ui-input"
                inputMode="numeric"
                placeholder="未設定なら警告なし"
                value={warnQty}
                onChange={(e) => setWarnQty(e.target.value)}
              />
            </label>
          </div>

          <label className="equipment-checkbox-field">
            <input type="checkbox" checked={trackStock} onChange={(e) => setTrackStock(e.target.checked)} />
            在庫数を管理する
          </label>
          <label className="equipment-checkbox-field">
            <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
            無効にする（選択肢に出さない）
          </label>

          <label className="ui-field">
            <span>備考</span>
            <textarea className="ui-textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>

        <div className="ui-modal-foot">
          <div className="ui-modal-foot-start">
            {existing && <ConfirmDeleteButton onConfirm={handleDelete} label="この備品を削除" size={22} />}
          </div>
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
