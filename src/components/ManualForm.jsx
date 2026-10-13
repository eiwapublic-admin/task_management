import { useMemo, useState } from 'react'
import ConfirmDeleteButton from './ConfirmDeleteButton'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import {
  MANUAL_KINDS,
  MANUAL_FIELD_DEFS,
  convertManualFields,
  createManual,
  updateManual,
  deleteManual,
} from '../lib/manuals'

// 業務マニュアルの1項目の追加・修正（2026-10-13〜）。分類（対応方法・定例作業）は色付きラベルで選ぶ。
// 修正でも選び直せ、その場合は中身を近い項目へ移す（convertManualFields）。
// 「関連」には、この項目から参照する別の項目（例: 定例作業 → 関連手順）をチェックで選ぶ
export default function ManualForm({ existing, defaultKind = 'response', manuals, onClose, onSaved, onDeleted }) {
  useBodyScrollLock()

  const [kind, setKind] = useState(existing?.kind || defaultKind)
  const [no, setNo] = useState(existing?.no != null ? String(existing.no) : '')
  const [title, setTitle] = useState(existing?.title || '')
  const [fields, setFields] = useState(() => ({ ...(existing?.fields || {}) }))
  const [body, setBody] = useState(existing?.body || '')
  const [related, setRelated] = useState(() => new Set(existing?.related_ids || []))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const kindDef = MANUAL_KINDS.find((k) => k.key === kind)
  const candidates = useMemo(() => manuals.filter((m) => m.id !== existing?.id), [manuals, existing])

  function changeKind(next) {
    if (next === kind) return
    setFields((prev) => convertManualFields(prev, kind, next))
    setKind(next)
  }

  function toggleRelated(id) {
    setRelated((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleSave() {
    setError('')
    if (!title.trim()) return setError(`${kindDef.titleLabel}を入力してください`)
    setSaving(true)
    try {
      const payload = { kind, no: no.trim(), title, fields, body, related_ids: [...related] }
      const saved = existing ? await updateManual(existing.id, payload) : await createManual(payload)
      onSaved(saved)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  async function handleDelete() {
    try {
      await deleteManual(existing.id)
      onDeleted()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="ui-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="ui-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h3 className="ui-modal-title">{existing ? '業務マニュアルの修正' : '業務マニュアルに追加'}</h3>
          <button type="button" className="icon-btn-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>

        <div className="ui-modal-body is-stacked">
          <div className="ui-field">
            <span>分類</span>
            <div className="manuals-kind-choices" role="radiogroup" aria-label="分類">
              {MANUAL_KINDS.map((k) => (
                <button
                  key={k.key}
                  type="button"
                  role="radio"
                  aria-checked={kind === k.key}
                  className={`manuals-kind-label is-${k.key} is-choice${kind === k.key ? ' is-selected' : ''}`}
                  onClick={() => changeKind(k.key)}
                >
                  {k.label}
                </button>
              ))}
            </div>
            {existing && kind !== existing.kind && (
              <p className="ui-note">分類を変えたので、中身を近い項目へ移しました（対応方法⇔作業内容、留意事項・連絡先⇔備考）。保存前に確かめてください。</p>
            )}
          </div>

          <div className="ui-field-row">
            <label className="ui-field manuals-form-no">
              <span>No</span>
              <input
                type="number"
                className="ui-input"
                inputMode="numeric"
                min="0"
                placeholder="自動"
                value={no}
                onChange={(e) => setNo(e.target.value)}
              />
            </label>
            <label className="ui-field">
              <span>{kindDef.titleLabel}</span>
              <input type="text" className="ui-input" value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
          </div>

          {(MANUAL_FIELD_DEFS[kind] || []).map((d) => (
            <label key={d.key} className="ui-field">
              <span>{d.label}</span>
              <textarea
                className="ui-textarea"
                rows={d.key === 'method' || d.key === 'content' ? 5 : 2}
                value={fields[d.key] || ''}
                onChange={(e) => setFields((prev) => ({ ...prev, [d.key]: e.target.value }))}
              />
            </label>
          ))}

          <label className="ui-field">
            <span>手順（長い手順を書くとき）</span>
            <textarea className="ui-textarea" rows={body ? 12 : 3} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>

          <div className="ui-field">
            <span>関連（この項目から参照する別の項目）</span>
            <div className="manuals-related-picker">
              {MANUAL_KINDS.map((k) => {
                const rows = candidates.filter((m) => m.kind === k.key)
                if (rows.length === 0) return null
                return (
                  <div key={k.key}>
                    <p className="manuals-related-picker-head">{k.label}</p>
                    {rows.map((m) => (
                      <label key={m.id} className="manuals-related-option">
                        <input type="checkbox" checked={related.has(m.id)} onChange={() => toggleRelated(m.id)} />
                        <span>
                          {m.no != null ? `${m.no}. ` : ''}
                          {m.title}
                        </span>
                      </label>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {error && (
          <p className="ui-modal-alert" role="alert">
            {error}
          </p>
        )}

        <div className="ui-modal-foot">
          <div className="ui-modal-foot-start">
            {existing && <ConfirmDeleteButton onConfirm={handleDelete} label="この項目を削除" size={22} />}
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
