import { useState } from 'react'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import Combobox from './Combobox'
import { createDocument } from '../lib/documents'
import { formatBytes } from '../lib/imageResize'
import { formatDate } from '../lib/format'

// 雛形ファイルの登録モーダル（2026-08-30）。資料名称・分類・備考は画面で入力し、
// 物理ファイル名・拡張子・サイズ・最終更新日はファイル選択と同時に自動で取得して見せる
// （分類は既存データからの選択式にするため、呼び出し元から候補一覧を受け取る）。
export default function DocumentTemplateForm({ categories, onClose, onSaved }) {
  useBodyScrollLock()

  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [remark, setRemark] = useState('')
  const [file, setFile] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSave() {
    setError('')
    if (!name.trim()) return setError('資料名称は必須です')
    if (!category.trim()) return setError('分類は必須です')
    if (!file) return setError('ファイルを選択してください')

    setSaving(true)
    try {
      const saved = await createDocument({
        name: name.trim(),
        category: category.trim(),
        remark: remark.trim(),
        file,
      })
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
          <h3 className="ui-modal-title">雛形ファイルを登録</h3>
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

          <label className="ui-field">
            <span>ファイル</span>
            <input
              type="file"
              className="ui-input"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </label>
          {/* 物理ファイル名・拡張子・サイズ・最終更新日はここで自動取得したものをそのまま
              登録時に送る（ユーザーが手で入力する項目ではないため、確認用に見せるだけ） */}
          {file && (
            <p className="doc-file-preview">
              {file.name} ・ {formatBytes(file.size)}
              {file.lastModified ? ` ・ 更新日 ${formatDate(file.lastModified)}` : ''}
            </p>
          )}

          <label className="ui-field">
            <span>資料名称</span>
            <input type="text" className="ui-input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <label className="ui-field">
            <span>分類</span>
            <Combobox
              value={category}
              onChange={setCategory}
              options={categories}
              placeholder="例: 見積書・契約書式・報告書 など"
            />
          </label>

          <label className="ui-field">
            <span>備考</span>
            <textarea className="ui-textarea" rows={3} value={remark} onChange={(e) => setRemark(e.target.value)} />
          </label>
        </div>

        <div className="ui-modal-foot">
          <div className="ui-modal-foot-start" />
          <div className="ui-modal-foot-end">
            <button type="button" className="btn-plain" onClick={onClose}>
              キャンセル
            </button>
            <button type="button" className="btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? '登録中…' : '登録する'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
