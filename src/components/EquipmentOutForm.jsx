import { useEffect, useMemo, useRef, useState } from 'react'
import ConfirmDeleteButton from './ConfirmDeleteButton'
import Combobox from './Combobox'
import SignaturePad from './SignaturePad'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import { toDateTimeLocal } from '../lib/reports'
import DateTimeInput from './DateTimeInput'
import {
  EQUIPMENT_OUT_REASONS,
  createEquipmentTransaction,
  updateEquipmentTransaction,
  fetchEquipmentSuggest,
  fetchEquipmentTenants,
  uploadEquipmentSignature,
  equipmentSignatureUrl,
} from '../lib/equipment'

function tenantLabel(t) {
  const name = t.short_name || t.name
  return t.floor ? `${name}（${t.floor}F）` : name
}

// 出庫・設置モーダル（5-4）。docs/equipment-plan.md 5-4・5-5・11章。
// existing を渡すと編集モード（履歴画面・在庫一覧の明細タップから開く）になる。
// defaultItemId を渡すと、その備品をあらかじめ選んだ状態で開く（在庫一覧の行の「出」ボタン等。
// 2026-08-18）。どちらも無ければ備品は空欄から選ばせる（ヘッダの「出庫」ボタンから開いた場合）。
// dateLocked・canDelete は備品出庫限定ロール用（2026-08-25追加）。当日入力分の出庫の修正のみを
// 許可するロールのため、出庫日時は動かせないようにし（過去日付への付け替えを防ぐ）、
// 削除は許可されていないため削除ボタン自体を出さない
export default function EquipmentOutForm({
  items,
  existing,
  defaultItemId,
  dateLocked = false,
  canDelete = true,
  onClose,
  onSaved,
  onDelete,
}) {
  useBodyScrollLock()

  const trackedItems = useMemo(() => items.filter((i) => !i.disabled || i.id === existing?.item_id), [items, existing])
  const [itemId, setItemId] = useState(existing?.item_id || defaultItemId || '')
  // 既存編集時・在庫一覧の行から備品を指定して開いた時は、テナント選択による
  // 自動デフォルト備品で上書きしない（2026-08-18。defaultItemId分を追加）
  const itemTouchedRef = useRef(Boolean(existing) || Boolean(defaultItemId))
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
  // 本体（出庫レコード）は保存できたが署名の登録だけ失敗した場合に保持する。
  // これが入っている間の再保存では、本体を作り直さず署名の登録だけをやり直す
  // （2026-08-25。以前は失敗時もモーダルが閉じてしまい、エラーに気づけないまま
  // 再度「記録する」を押すと同じ内容の記録が重複作成されてしまっていた）
  const [savedTxn, setSavedTxn] = useState(null)

  // テナント選択（5-4）
  const [tenants, setTenants] = useState([])
  const [tenantId, setTenantId] = useState(existing?.tenant_id || '')
  const [tenantInput, setTenantInput] = useState(existing?.tenant_short_name || existing?.tenant_name || '')
  const signatureRef = useRef(null)
  const isSigned = Boolean(existing?.signed_at)

  useEffect(() => {
    fetchEquipmentSuggest('location').then(setLocationOptions).catch(() => {})
    fetchEquipmentSuggest('staff').then(setStaffOptions).catch(() => {})
    // 退去済みも含めて取得する（編集中の記録が過去に退去済みテナントへ設置していた場合、
    // 一覧から消えて選択欄の表示が壊れないようにするため。候補としては後で絞り込む）
    fetchEquipmentTenants({ includeMovedOut: true }).then(setTenants).catch(() => {})
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

  const activeTenants = useMemo(() => tenants.filter((t) => !t.moved_out), [tenants])
  // 編集中の記録が退去済みテナント宛てだった場合も候補に混ぜて、選択欄の表示が空にならないようにする
  const tenantOptions = useMemo(() => {
    if (!tenantId || activeTenants.some((t) => t.id === tenantId)) return activeTenants
    const current = tenants.find((t) => t.id === tenantId)
    return current ? [current, ...activeTenants] : activeTenants
  }, [activeTenants, tenants, tenantId])
  const selectedTenant = tenants.find((t) => t.id === tenantId) || null

  function handleTenantChange(value) {
    setTenantInput(value)
    if (!tenantOptions.some((t) => tenantLabel(t) === value)) setTenantId('')
  }

  function handleTenantSelect(id) {
    setTenantId(id)
    const match = tenantOptions.find((t) => t.id === id)
    if (match && !itemTouchedRef.current && match.default_item_id && trackedItems.some((i) => i.id === match.default_item_id)) {
      setItemId(match.default_item_id)
    }
  }

  const selectedItem = trackedItems.find((i) => i.id === itemId)
  const beforeQty = selectedItem?.track_stock ? selectedItem.stock_qty ?? 0 : null
  const numericQty = quantity === '' ? null : Number(quantity)
  const afterQty = beforeQty !== null && Number.isFinite(numericQty) ? beforeQty - numericQty : null

  async function handleSave() {
    setError('')
    if (!itemId) return setError('備品を選択してください')
    if (!Number.isFinite(numericQty) || numericQty <= 0) return setError('出庫数量を入力してください')
    if (reason === 'tenant' && !tenantId) return setError('設置先テナントを選択してください')

    setSaving(true)
    try {
      // 本体（出庫レコード）は既に保存済み（署名だけ失敗して再保存した）なら
      // 作り直さない。二重登録を防ぐため（2026-08-25）
      let saved = savedTxn
      if (!saved) {
        const payload = {
          reason,
          occurred_at: occurredAt ? new Date(occurredAt).toISOString() : new Date().toISOString(),
          location: reason === 'common' ? location || null : null,
          staff_name: staffName || null,
          note: note || null,
          quantity: numericQty,
          ...(reason === 'tenant' ? { tenant_id: tenantId } : {}),
        }
        saved = existing
          ? await updateEquipmentTransaction(existing.id, payload)
          : await createEquipmentTransaction({ item_id: itemId, kind: 'out', ...payload })
        setSavedTxn(saved)
      }

      // 署名は同じ保存操作の中で続けて登録する（新規保存と同時／未署名の記録への後付け、両方をこの1本でまかなう）。
      // ここで失敗した場合は本体だけ保存済みの状態でモーダルを開いたままにし、
      // エラーを表示してユーザーが署名だけ再送信できるようにする（2026-08-25。
      // 以前はここで捕捉したエラーの直後に必ずonSaved()を呼んでモーダルを閉じてしまい、
      // エラーメッセージが表示される前にコンポーネントごと消えて気づけなかった）
      let finalSaved = saved
      if (reason === 'tenant' && signatureRef.current && !signatureRef.current.isEmpty()) {
        const blob = await signatureRef.current.getBlob()
        if (blob) {
          finalSaved = await uploadEquipmentSignature(saved.id, blob)
        }
      }
      onSaved(finalSaved)
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

          {isSigned && (
            <p className="ui-note">署名済みの記録です。修正できません（内容の確認のみできます）。</p>
          )}

          <div className="equipment-reason-field">
            <span>設置先／出庫理由</span>
            <div className="equipment-reason-toggle" role="group" aria-label="設置先／出庫理由">
              {EQUIPMENT_OUT_REASONS.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  className={`btn-plain equipment-reason-btn${reason === r.key ? ' is-active' : ''}`}
                  aria-pressed={reason === r.key}
                  disabled={isSigned}
                  onClick={() => setReason(r.key)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          <label className="ui-field">
            <span>出庫日時</span>
            <DateTimeInput value={occurredAt} disabled={isSigned || dateLocked} onChange={setOccurredAt} />
          </label>

          <label className="ui-field">
            <span>備品</span>
            <select
              className="ui-select"
              value={itemId}
              disabled={Boolean(existing) || isSigned}
              onChange={(e) => {
                itemTouchedRef.current = true
                setItemId(e.target.value)
              }}
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

          {reason === 'tenant' && (
            <div className="ui-field">
              <span>設置先テナント</span>
              <Combobox
                value={tenantInput}
                onChange={handleTenantChange}
                onSelect={handleTenantSelect}
                options={tenantOptions.map((t) => ({ key: t.id, label: tenantLabel(t) }))}
                placeholder="テナント名で検索"
                disabled={isSigned}
              />
              {selectedTenant ? (
                <p className="equipment-tenant-summary">
                  設置階: {selectedTenant.floor ? `${selectedTenant.floor}F` : '—'}
                  {selectedTenant.moved_out && '（退去済み）'}
                </p>
              ) : (
                tenantInput && <p className="equipment-tenant-summary is-danger">候補から選択してください</p>
              )}
            </div>
          )}

          {reason === 'common' && (
            <div className="ui-field">
              <span>設置場所</span>
              <Combobox
                value={location}
                onChange={setLocation}
                options={locationOptions}
                placeholder="喫煙室 / 通路 / 玄関ホール"
                disabled={isSigned}
              />
            </div>
          )}

          <div className="ui-field-row">
            <label className="ui-field">
              <span>出庫数量</span>
              <input
                type="number"
                className="ui-input"
                inputMode="numeric"
                min="1"
                value={quantity}
                disabled={isSigned}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </label>

            <div className="ui-field">
              <span>担当者</span>
              <Combobox value={staffName} onChange={setStaffName} options={staffOptions} disabled={isSigned} />
            </div>
          </div>

          {!existing && beforeQty !== null && (
            <p className={`ui-note${afterQty !== null && afterQty < 0 ? ' is-danger' : ''}`}>
              在庫の変化: {beforeQty} → {afterQty !== null ? afterQty : '?'}
              {afterQty !== null && afterQty < 0 && '（在庫がマイナスになります）'}
            </p>
          )}

          <label className="ui-field">
            <span>備考</span>
            <textarea
              className="ui-textarea is-compact"
              rows={1}
              value={note}
              disabled={isSigned}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>

          {reason === 'tenant' && (
            <div className="ui-field">
              <span className="equipment-signature-label">受領サイン</span>
              {isSigned ? (
                <div className="equipment-signature-status">
                  <img
                    className="equipment-signature-thumb"
                    src={equipmentSignatureUrl(existing.id)}
                    alt="受領サイン"
                  />
                  <span className="ui-badge is-current">署名済み</span>
                </div>
              ) : (
                <>
                  <SignaturePad ref={signatureRef} />
                  <p className="ui-note">
                    署名は必須ではありません。その場でもらえない場合は空欄のまま保存し、あとでこの記録を開いて署名だけ追加できます。
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        <div className="ui-modal-foot">
          <div className="ui-modal-foot-start">
            {existing && !isSigned && canDelete && (
              <ConfirmDeleteButton onConfirm={() => onDelete(existing.id)} label="この記録を削除" size={22} />
            )}
          </div>
          <div className="ui-modal-foot-end">
            <button type="button" className="btn-plain" onClick={onClose}>
              {isSigned ? '閉じる' : 'キャンセル'}
            </button>
            {!isSigned && (
              <button type="button" className="btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? '保存中…' : '記録する'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
