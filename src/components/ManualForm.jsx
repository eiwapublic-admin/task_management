import { useMemo, useRef, useState } from 'react'
import ConfirmDeleteButton from './ConfirmDeleteButton'
import { IconClip } from './Icons'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import {
  MANUAL_KINDS,
  MANUAL_FIELD_DEFS,
  convertManualFields,
  createManual,
  updateManual,
  deleteManual,
  uploadManualAttachment,
  deleteManualAttachment,
  formatFileSize,
  MANUAL_ATTACHMENT_MAX_BYTES,
} from '../lib/manuals'

// 業務マニュアルの1項目の追加・修正（2026-10-13〜）。分類（対応方法・定例作業）は色付きラベルで選ぶ。
// 修正でも選び直せ、その場合は中身を近い項目へ移す（convertManualFields）。
// 「関連」には、この項目から参照する別の項目（例: 定例作業 → 関連手順）をチェックで選ぶ。
// 添付ファイル（2026-10-26〜）は選んだ時点では送らず、「保存する」で項目を保存したあとに追加・削除する
export default function ManualForm({ existing, defaultKind = 'response', manuals, onClose, onSaved, onDeleted }) {
  useBodyScrollLock()

  const [kind, setKind] = useState(existing?.kind || defaultKind)
  const [no, setNo] = useState(existing?.no != null ? String(existing.no) : '')
  const [title, setTitle] = useState(existing?.title || '')
  const [fields, setFields] = useState(() => ({ ...(existing?.fields || {}) }))
  const [body, setBody] = useState(existing?.body || '')
  const [related, setRelated] = useState(() => new Set(existing?.related_ids || []))
  const [newFiles, setNewFiles] = useState([]) // まだ送っていない File
  const [removedIds, setRemovedIds] = useState(() => new Set()) // 保存時に消す添付ファイルの id
  const [deletedIds, setDeletedIds] = useState(() => new Set()) // 消し終えた添付ファイルの id
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef(null)
  // 項目の保存は済んだが添付で失敗したとき、やり直しで項目を二重に作らないよう保存済みの id を覚えておく
  const savedRef = useRef(existing || null)

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

  // 途中まで保存できていたら（添付で失敗したあと閉じたとき）一覧を読み直してもらう
  function close() {
    if (savedRef.current && savedRef.current !== existing) onSaved(savedRef.current)
    else onClose()
  }

  function addFiles(list) {
    const files = [...(list || [])]
    const tooBig = files.filter((f) => f.size > MANUAL_ATTACHMENT_MAX_BYTES)
    if (tooBig.length) setError(`20MBを超えるファイルは添付できません（${tooBig.map((f) => f.name).join('、')}）`)
    else setError('')
    setNewFiles((prev) => [...prev, ...files.filter((f) => f.size <= MANUAL_ATTACHMENT_MAX_BYTES)])
  }

  function toggleRemoved(id) {
    setRemovedIds((prev) => {
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
      const saved = savedRef.current ? await updateManual(savedRef.current.id, payload) : await createManual(payload)
      savedRef.current = saved
      for (const id of removedIds) {
        await deleteManualAttachment(id)
        setDeletedIds((prev) => new Set(prev).add(id))
        setRemovedIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
      for (const file of newFiles) {
        await uploadManualAttachment(saved.id, file)
        setNewFiles((prev) => prev.filter((f) => f !== file))
      }
      onSaved(saved)
    } catch (err) {
      setError(savedRef.current ? `項目は保存しましたが、添付ファイルで失敗しました: ${err.message}` : err.message)
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
    <div className="ui-overlay" role="dialog" aria-modal="true" onClick={close}>
      <div className="ui-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h3 className="ui-modal-title">{existing ? '業務マニュアルの修正' : '業務マニュアルに追加'}</h3>
          <button type="button" className="icon-btn-close" onClick={close} aria-label="閉じる">
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
            <span>添付ファイル（写真・PDF・Excel など。1ファイル20MBまで）</span>
            <ul className="manuals-form-attachments">
              {(existing?.attachments || []).filter((a) => !deletedIds.has(a.id)).map((a) => (
                <li key={a.id} className={`manuals-form-attachment${removedIds.has(a.id) ? ' is-removed' : ''}`}>
                  <IconClip size={14} />
                  <span className="manuals-form-attachment-name">{a.filename}</span>
                  <span className="manuals-form-attachment-size">{formatFileSize(a.file_size)}</span>
                  <button type="button" className="btn-plain" onClick={() => toggleRemoved(a.id)} disabled={saving}>
                    {removedIds.has(a.id) ? '戻す' : '削除'}
                  </button>
                </li>
              ))}
              {newFiles.map((f, i) => (
                <li key={`${f.name}-${i}`} className="manuals-form-attachment is-new">
                  <IconClip size={14} />
                  <span className="manuals-form-attachment-name">{f.name}（保存時に追加）</span>
                  <span className="manuals-form-attachment-size">{formatFileSize(f.size)}</span>
                  <button
                    type="button"
                    className="btn-plain"
                    onClick={() => setNewFiles((prev) => prev.filter((x) => x !== f))}
                    disabled={saving}
                  >
                    取消
                  </button>
                </li>
              ))}
            </ul>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                addFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <button
              type="button"
              className="btn-plain manuals-form-attachment-add"
              onClick={() => fileInputRef.current?.click()}
              disabled={saving}
            >
              ＋ ファイルを追加
            </button>
          </div>

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
            <button type="button" className="btn-plain" onClick={close}>
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
