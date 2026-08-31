import { useEffect, useRef, useState } from 'react'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import Combobox from './Combobox'
import ConfirmDeleteButton from './ConfirmDeleteButton'
import {
  createDocument,
  updateDocument,
  getEffectivePdf,
  getDocumentPreviewUrl,
  fetchDocumentThumbnailUrl,
} from '../lib/documents'
import { prepareDocumentThumbnail, formatBytes } from '../lib/imageResize'
import { renderPdfFirstPageToBlob } from '../lib/pdfThumbnail'
import { formatDate } from '../lib/format'

// 拡張子が .pdf かどうか（mimeは環境により空/不正確なことがあるため拡張子で見る。
// DocumentTemplates.jsx のPDF判定と同じ考え方）
function isPdfFile(f) {
  return /\.pdf$/i.test(f?.name || '')
}

// 雛形ファイルの登録・編集モーダル（2026-08-31〜。新規登録も既存の編集も同じ画面で行う）。
// 原本・PDF版・サムネイルの3ファイルをこの1画面でまとめて登録・上書きできる。
// サムネイルは、①ユーザーが画像を選べばそれを縮小して使い、②選ばなければ登録された
// PDF（原本がPDFの場合はその原本、そうでなければPDF版）の1ページ目をブラウザ側
// （pdfjs-dist）で自動的に縮小して使う。doc（既存の登録）を渡せば編集モードになる。
export default function DocumentTemplateForm({ doc, categories, readOnly, onClose, onSaved, onDelete }) {
  useBodyScrollLock()
  const isEdit = Boolean(doc)

  const [name, setName] = useState(doc?.name || '')
  const [category, setCategory] = useState(doc?.category || '')
  const [remark, setRemark] = useState(doc?.remark || '')
  const [file, setFile] = useState(null)
  const [pdfFile, setPdfFile] = useState(null)
  const [thumbnailFile, setThumbnailFile] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // サムネイルのプレビュー（Blob URL）と、保存時に送る縮小済みBlob。
  // pendingThumbBlob が null のままなら「変更なし」（編集時は既存のまま、新規登録時は無し）
  const [previewUrl, setPreviewUrl] = useState(null)
  const [pendingThumbBlob, setPendingThumbBlob] = useState(null)
  const [thumbBusy, setThumbBusy] = useState(false)
  const createdUrls = useRef(new Set())
  const thumbInputRef = useRef(null)
  // 既存PDFからの自動穴埋めは1度成功すれば十分なので、ファイル選択のたびに
  // 再取得・再生成しないようフラグで抑える
  const backfillTriedRef = useRef(false)

  // 選び直していない場合の「今のところの原本」がPDFかどうか（PDF版欄の要否に使う）
  const originalIsPdf = file
    ? isPdfFile(file)
    : Boolean(doc && (doc.mime === 'application/pdf' || (doc.file_ext || '').toLowerCase() === 'pdf'))

  // 編集時、既にサムネイルが登録されていれば初期表示として取得する
  useEffect(() => {
    if (!doc?.has_thumbnail) return
    let cancelled = false
    fetchDocumentThumbnailUrl(doc.id)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url)
          return
        }
        createdUrls.current.add(url)
        setPreviewUrl(url)
      })
      .catch(() => {}) // 取れなくてもプレースホルダー表示のままにする
    return () => {
      cancelled = true
    }
  }, [doc?.id, doc?.has_thumbnail])

  // サムネイルの自動生成・更新。①手動選択した画像を最優先、②無ければ新しく選ばれた
  // PDF（原本 or PDF版）の1ページ目から自動生成、③どちらも無ければ、編集中でまだ
  // サムネイルが無い登録に限り既存のPDFから自動生成する（この機能追加前の登録の穴埋め）
  useEffect(() => {
    let cancelled = false
    async function run() {
      let source = null
      let mode = null
      if (thumbnailFile) {
        source = thumbnailFile
        mode = 'image'
      } else {
        const pdfSource = file && isPdfFile(file) ? file : pdfFile
        if (pdfSource) {
          source = pdfSource
          mode = 'pdf'
        }
      }
      if (!source && doc && !doc.has_thumbnail && !backfillTriedRef.current) {
        backfillTriedRef.current = true
        const effective = getEffectivePdf(doc)
        if (effective) {
          try {
            const url = await getDocumentPreviewUrl(doc.id, effective.kind)
            const res = await fetch(url)
            if (res.ok) {
              source = await res.blob()
              mode = 'pdf'
            }
          } catch {
            // 取得できなくてもプレースホルダー表示のまま続行する
          }
        }
      }
      if (!source) return

      setThumbBusy(true)
      setError('')
      try {
        const blob = mode === 'image' ? await prepareDocumentThumbnail(source) : await renderPdfFirstPageToBlob(source)
        if (cancelled) return
        const url = URL.createObjectURL(blob)
        createdUrls.current.add(url)
        setPendingThumbBlob(blob)
        setPreviewUrl((prev) => {
          if (prev) {
            URL.revokeObjectURL(prev)
            createdUrls.current.delete(prev)
          }
          return url
        })
      } catch {
        if (!cancelled) setError('サムネイルの生成に失敗しました（このまま保存もできます）')
      } finally {
        if (!cancelled) setThumbBusy(false)
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [file, pdfFile, thumbnailFile, doc])

  // アンマウント時に作成した Blob URL をまとめて解放する
  useEffect(() => {
    const set = createdUrls.current
    return () => {
      for (const url of set) URL.revokeObjectURL(url)
      set.clear()
    }
  }, [])

  // ファイル選択時、資料名称が未入力ならファイル名（拡張子なし）を自動で入れる
  function handleFileChange(e) {
    const f = e.target.files?.[0] || null
    setFile(f)
    if (f && !name.trim()) {
      setName(f.name.replace(/\.[^./]+$/, ''))
    }
  }

  async function handleSave() {
    setError('')
    if (!name.trim()) return setError('資料名称は必須です')
    if (!category.trim()) return setError('分類は必須です')
    if (!isEdit && !file) return setError('原本ファイルを選択してください')
    if (pdfFile && !isPdfFile(pdfFile)) return setError('PDF版はPDFファイル（拡張子.pdf）を選択してください')

    setSaving(true)
    try {
      const payload = {
        name: name.trim(),
        category: category.trim(),
        remark: remark.trim(),
        file,
        pdfFile: originalIsPdf ? null : pdfFile,
        thumbnail: pendingThumbBlob,
      }
      const saved = isEdit ? await updateDocument(doc.id, payload) : await createDocument(payload)
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
          <h3 className="ui-modal-title">{isEdit ? '雛形ファイルを編集' : '雛形ファイルを登録'}</h3>
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

          <div className="doc-thumb-field">
            <div className="doc-thumb-preview">
              {thumbBusy ? (
                <span className="doc-thumb-loading">生成中…</span>
              ) : previewUrl ? (
                <img src={previewUrl} alt="サムネイル" />
              ) : (
                <span className="doc-thumb-placeholder">サムネ</span>
              )}
            </div>
            {!readOnly && (
              <div className="doc-thumb-actions">
                <button type="button" className="btn-plain" onClick={() => thumbInputRef.current?.click()}>
                  画像を選ぶ
                </button>
                <p className="doc-field-hint">
                  未指定ならPDF（原本またはPDF版）の1ページ目から自動で作成されます。
                </p>
              </div>
            )}
            <input
              ref={thumbInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => setThumbnailFile(e.target.files?.[0] || null)}
            />
          </div>

          <label className="ui-field">
            <span>原本ファイル{isEdit ? '（差し替える場合のみ選択）' : ''}</span>
            <input type="file" className="ui-input" onChange={handleFileChange} disabled={readOnly} />
          </label>
          {file ? (
            <p className="doc-file-preview">
              {file.name} ・ {formatBytes(file.size)}
              {file.lastModified ? ` ・ 更新日 ${formatDate(file.lastModified)}` : ''}
            </p>
          ) : (
            isEdit && (
              <p className="doc-file-preview">
                現在: {doc.original_filename}
                {doc.file_size != null ? ` ・ ${formatBytes(doc.file_size)}` : ''}
                {doc.file_modified_at ? ` ・ 更新日 ${formatDate(doc.file_modified_at)}` : ''}
              </p>
            )
          )}

          {/* 原本がPDF以外（Word/Excel等）の場合だけ、印刷用のPDF版もあわせて登録できる */}
          {!originalIsPdf && (
            <label className="ui-field">
              <span>PDF版（任意）</span>
              <input
                type="file"
                accept=".pdf,application/pdf"
                className="ui-input"
                disabled={readOnly}
                onChange={(e) => setPdfFile(e.target.files?.[0] || null)}
              />
              <p className="doc-field-hint">
                原本がPDF以外の場合、あわせてPDF版を登録すると一覧からすぐプレビュー・印刷できます。
                原本をご自身のアプリ（Word/Excel等の「PDFとして保存」機能）でPDF化してから選んでください。
              </p>
              {pdfFile ? (
                <p className="doc-file-preview">
                  {pdfFile.name} ・ {formatBytes(pdfFile.size)}
                  {pdfFile.lastModified ? ` ・ 更新日 ${formatDate(pdfFile.lastModified)}` : ''}
                </p>
              ) : (
                doc?.pdf_original_filename && (
                  <p className="doc-file-preview">
                    現在: {doc.pdf_original_filename}
                    {doc.pdf_file_size != null ? ` ・ ${formatBytes(doc.pdf_file_size)}` : ''}
                    {doc.pdf_file_modified_at ? ` ・ 更新日 ${formatDate(doc.pdf_file_modified_at)}` : ''}
                  </p>
                )
              )}
            </label>
          )}

          <label className="ui-field">
            <span>資料名称</span>
            <input
              type="text"
              className="ui-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={readOnly}
            />
          </label>

          <label className="ui-field">
            <span>分類</span>
            <Combobox
              value={category}
              onChange={setCategory}
              options={categories}
              placeholder="例: 見積書・契約書式・報告書 など"
              disabled={readOnly}
            />
          </label>

          <label className="ui-field">
            <span>備考</span>
            <textarea
              className="ui-textarea"
              rows={3}
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              disabled={readOnly}
            />
          </label>
        </div>

        <div className="ui-modal-foot">
          <div className="ui-modal-foot-start">
            {isEdit && !readOnly && (
              <ConfirmDeleteButton onConfirm={() => onDelete(doc.id)} label={`${doc.name}を削除`} size={20} />
            )}
          </div>
          <div className="ui-modal-foot-end">
            <button type="button" className="btn-plain" onClick={onClose}>
              {readOnly ? '閉じる' : 'キャンセル'}
            </button>
            {!readOnly && (
              <button type="button" className="btn-primary" onClick={handleSave} disabled={saving || thumbBusy}>
                {saving ? '保存中…' : '保存する'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
