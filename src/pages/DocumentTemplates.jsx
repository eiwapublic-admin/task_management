import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import DocumentTemplateForm from '../components/DocumentTemplateForm'
import ConfirmDeleteButton from '../components/ConfirmDeleteButton'
import AttachmentPreview from '../components/AttachmentPreview'
import { IconDownload, IconSearch } from '../components/Icons'
import {
  fetchDocuments,
  fetchDocumentCategories,
  deleteDocument,
  downloadDocument,
  getDocumentPreviewUrl,
  attachDocumentPdf,
  attachDocumentOriginal,
} from '../lib/documents'
import { formatBytes } from '../lib/imageResize'
import { formatDateTime } from '../lib/format'
import { getCurrentUser, isLimitedRole } from '../lib/auth'
import './DocumentTemplates.css'
// AttachmentPreview（PDFのプレビューモーダル）の見た目は本来タスク管理側の KanbanBoard.css で
// 定義されており、日報等を経由せずこの画面を直接開いた場合はまだ読み込まれていないことが
// あるため、ここでも明示的に import しておく（Inspections.jsx と同じ対応）
import '../components/KanbanBoard.css'

// このドキュメントで「プレビュー可能なPDF」として扱えるものを1つ求める（2026-08-30追加）。
// 優先順位: 別登録されたPDF版 > 原本自体がPDFの場合はその原本。どちらも無ければnull
// （原本がWord/Excel等でPDF版も未登録の場合。一覧では「未登録」表示になる）
function getEffectivePdf(doc) {
  if (doc.pdf_original_filename) {
    return { kind: 'pdf', filename: doc.pdf_original_filename, hasOwnInfo: true }
  }
  const ext = (doc.file_ext || '').toLowerCase()
  if (doc.mime === 'application/pdf' || ext === 'pdf') {
    return { kind: 'original', filename: doc.original_filename, hasOwnInfo: false }
  }
  return null
}

// 雛形ファイル（業務で使う資料テンプレート）画面（2026-08-30〜）。
// 「登録していつでもダウンロードできる資料置き場」。分類ごとにグループ化し、
// グループ内は資料名称順に並べる。owner・備品出庫限定ロールは閲覧・ダウンロードのみ
// （書き込みはサーバー側でも拒否されるが、UIでもボタン自体を出さない）。
//
// 一覧の1件は2行で表示する（2026-08-30の依頼によるレイアウト）。
//   1行目: 資料名称／[原本ボタン(黒)]+ファイル情報／[PDFボタン(青)]+ファイル情報／削除
//   2行目: 備考（インデント・グレー）／原本の差し替えリンク／PDFの差し替え(or追加)リンク
// 差し替えリンクは対応するボタンの真下（同じ列）に来るようにし、表全体は
// table-layout: fixed で列幅を固定することで、グループ（分類）が違っても
// タブ位置が揃うようにしている（DocumentTemplates.css参照）。
export default function DocumentTemplates() {
  const user = getCurrentUser()
  const readOnly = isLimitedRole(user)

  const [documents, setDocuments] = useState(null)
  const [categories, setCategories] = useState([])
  const [error, setError] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [downloadingId, setDownloadingId] = useState(null)
  const [attachingOriginalId, setAttachingOriginalId] = useState(null)
  const [attachingPdfId, setAttachingPdfId] = useState(null)
  // プレビュー表示中のファイル（{ doc, kind, filename, url }）。null なら非表示
  const [preview, setPreview] = useState(null)

  // 原本・PDF版それぞれの差し替え用の隠しinput。行ごとに<input>を持たず、
  // クリックされた行のidだけ覚えておいて共有の1個を使い回す
  const originalInputRef = useRef(null)
  const pendingOriginalDocIdRef = useRef(null)
  const pdfInputRef = useRef(null)
  const pendingPdfDocIdRef = useRef(null)

  const load = useCallback(() => {
    setError('')
    return Promise.all([fetchDocuments(), fetchDocumentCategories()])
      .then(([docs, cats]) => {
        setDocuments(docs)
        setCategories(cats)
      })
      .catch((err) => setError(err.message))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 分類ごとにグループ化し、グループは分類名順・グループ内は資料名称順に並べる
  // （備品マスタの年月グループと同じ「Mapに積んでからentriesをsortする」やり方）
  const groups = useMemo(() => {
    if (!documents) return []
    const map = new Map()
    for (const d of documents) {
      const key = d.category || ''
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(d)
    }
    const entries = [...map.entries()]
    entries.sort((a, b) => a[0].localeCompare(b[0], 'ja'))
    for (const [, rows] of entries) {
      rows.sort((a, b) => a.name.localeCompare(b.name, 'ja'))
    }
    return entries.map(([category, rows]) => ({ category, rows }))
  }, [documents])

  // 原本ボタン：ダウンロードするイメージのボタンなので、プレビューは挟まず直接保存する
  async function handleDownloadOriginal(doc) {
    setDownloadingId(doc.id)
    setError('')
    try {
      await downloadDocument(doc.id, doc.original_filename, 'original')
    } catch (err) {
      setError(err.message)
    } finally {
      setDownloadingId(null)
    }
  }

  // PDFボタン：プレビューするイメージのボタンなので、アプリ内プレビューを開く
  async function handlePreviewPdf(doc, info) {
    setDownloadingId(doc.id)
    setError('')
    try {
      const url = await getDocumentPreviewUrl(doc.id, info.kind)
      setPreview({ doc, kind: info.kind, filename: info.filename, url })
    } catch (err) {
      setError(err.message)
    } finally {
      setDownloadingId(null)
    }
  }

  // プレビューモーダル内の「ダウンロード」ボタン（今プレビュー中のファイルをそのまま保存）
  async function handleDownloadPreview() {
    if (!preview) return
    setDownloadingId(preview.doc.id)
    setError('')
    try {
      await downloadDocument(preview.doc.id, preview.filename, preview.kind)
    } catch (err) {
      setError(err.message)
    } finally {
      setDownloadingId(null)
    }
  }

  async function handleDelete(id) {
    setError('')
    try {
      await deleteDocument(id)
      setDocuments((prev) => prev.filter((d) => d.id !== id))
    } catch (err) {
      setError(err.message)
    }
  }

  function handleSaved(doc) {
    setFormOpen(false)
    setDocuments((prev) => [...(prev || []), doc])
    setCategories((prev) => (prev.includes(doc.category) ? prev : [doc.category, ...prev]))
  }

  function handleReplaceOriginal(doc) {
    pendingOriginalDocIdRef.current = doc.id
    originalInputRef.current?.click()
  }

  async function handleOriginalFileChange(e) {
    const file = e.target.files?.[0]
    const id = pendingOriginalDocIdRef.current
    e.target.value = '' // 同じファイルを選び直しても onChange が発火するようにする
    if (!file || !id) return
    setAttachingOriginalId(id)
    setError('')
    try {
      const updated = await attachDocumentOriginal(id, file)
      setDocuments((prev) => prev.map((d) => (d.id === id ? updated : d)))
    } catch (err) {
      setError(err.message)
    } finally {
      setAttachingOriginalId(null)
    }
  }

  // PDF版の追加・差し替え。原本はWord/Excel等のままで、印刷用のPDFだけを別に持たせる
  // （サーバー側でOffice文書→PDF変換は行わないため、依頼元が自分の環境でPDF化したものを
  // ここで登録する運用。docs/HANDOFF.md参照）
  function handleAddOrReplacePdf(doc) {
    pendingPdfDocIdRef.current = doc.id
    pdfInputRef.current?.click()
  }

  async function handlePdfFileChange(e) {
    const file = e.target.files?.[0]
    const id = pendingPdfDocIdRef.current
    e.target.value = '' // 同じファイルを選び直しても onChange が発火するようにする
    if (!file || !id) return
    setAttachingPdfId(id)
    setError('')
    try {
      const updated = await attachDocumentPdf(id, file)
      setDocuments((prev) => prev.map((d) => (d.id === id ? updated : d)))
    } catch (err) {
      setError(err.message)
    } finally {
      setAttachingPdfId(null)
    }
  }

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-narrow app-scroll">
        <FeatureHeader
          actions={
            !readOnly && (
              <button type="button" className="btn-primary" onClick={() => setFormOpen(true)}>
                ＋ 登録
              </button>
            )
          }
        />

        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}

        {documents === null ? (
          !error && <p className="dashboard-loading">読み込み中…</p>
        ) : groups.length === 0 ? (
          <p className="ui-empty">まだ雛形ファイルが登録されていません。</p>
        ) : (
          groups.map((g) => (
            <section className="doc-group" key={g.category}>
              <h3 className="ui-group-head">
                {g.category}
                <span className="ui-group-head-sub">{g.rows.length}件</span>
              </h3>
              <div className="ui-table-wrap">
                <table className="ui-table doc-table">
                  <thead>
                    <tr>
                      <th>資料名称</th>
                      <th>原本</th>
                      <th>PDF</th>
                      <th className="is-numeric">削除</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((d) => {
                      const effectivePdf = getEffectivePdf(d)
                      return (
                        <Fragment key={d.id}>
                          <tr className="doc-row-primary">
                            <td className="doc-name">{d.name}</td>
                            <td className="doc-file-cell">
                              <button
                                type="button"
                                className="doc-btn-original"
                                onClick={() => handleDownloadOriginal(d)}
                                disabled={downloadingId === d.id}
                                title={d.original_filename}
                              >
                                <IconDownload size={12} />
                                {(d.file_ext || 'FILE').toUpperCase()}
                              </button>
                              <div className="doc-file-info">
                                {d.file_size != null ? formatBytes(d.file_size) : ''}
                                {d.file_modified_at ? ` ・ 更新 ${formatDateTime(d.file_modified_at)}` : ''}
                              </div>
                            </td>
                            <td className="doc-file-cell">
                              {effectivePdf ? (
                                <>
                                  <button
                                    type="button"
                                    className="doc-btn-pdf"
                                    onClick={() => handlePreviewPdf(d, effectivePdf)}
                                    disabled={downloadingId === d.id}
                                    title={effectivePdf.filename}
                                  >
                                    <IconSearch size={12} />
                                    PDF
                                  </button>
                                  {effectivePdf.hasOwnInfo && (
                                    <div className="doc-file-info">
                                      {d.pdf_file_size != null ? formatBytes(d.pdf_file_size) : ''}
                                      {d.pdf_file_modified_at ? ` ・ 更新 ${formatDateTime(d.pdf_file_modified_at)}` : ''}
                                    </div>
                                  )}
                                </>
                              ) : (
                                <span className="doc-pdf-missing">未登録</span>
                              )}
                            </td>
                            <td className="is-numeric doc-actions">
                              {!readOnly && (
                                <ConfirmDeleteButton
                                  onConfirm={() => handleDelete(d.id)}
                                  label={`${d.name}を削除`}
                                  size={20}
                                />
                              )}
                            </td>
                          </tr>
                          <tr className="doc-row-sub">
                            <td className="doc-remark">{d.remark || ''}</td>
                            <td className="doc-replace-cell">
                              {!readOnly && (
                                <button
                                  type="button"
                                  className="doc-replace-link"
                                  onClick={() => handleReplaceOriginal(d)}
                                  disabled={attachingOriginalId === d.id}
                                >
                                  {attachingOriginalId === d.id ? '更新中…' : '差し替え'}
                                </button>
                              )}
                            </td>
                            <td className="doc-replace-cell">
                              {!readOnly && (
                                <button
                                  type="button"
                                  className="doc-replace-link"
                                  onClick={() => handleAddOrReplacePdf(d)}
                                  disabled={attachingPdfId === d.id}
                                >
                                  {attachingPdfId === d.id
                                    ? '登録中…'
                                    : d.pdf_original_filename
                                      ? '差し替え'
                                      : '＋ 追加'}
                                </button>
                              )}
                            </td>
                            <td />
                          </tr>
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ))
        )}
      </div>

      {/* 原本・PDF版それぞれの差し替え用。画面に1個ずつ置き、行ごとにクリックされたidを
          pendingOriginalDocIdRef／pendingPdfDocIdRef で覚えておいてから開く */}
      <input ref={originalInputRef} type="file" style={{ display: 'none' }} onChange={handleOriginalFileChange} />
      <input
        ref={pdfInputRef}
        type="file"
        accept=".pdf,application/pdf"
        style={{ display: 'none' }}
        onChange={handlePdfFileChange}
      />

      {formOpen && (
        <DocumentTemplateForm categories={categories} onClose={() => setFormOpen(false)} onSaved={handleSaved} />
      )}

      {preview && (
        <AttachmentPreview
          attachment={{ filename: preview.filename, mimeType: 'application/pdf' }}
          url={preview.url}
          onClose={() => setPreview(null)}
          headerAction={
            <button
              type="button"
              className="attachment-preview-share"
              onClick={handleDownloadPreview}
              disabled={downloadingId === preview.doc.id}
            >
              ダウンロード
            </button>
          }
        />
      )}
    </div>
  )
}
