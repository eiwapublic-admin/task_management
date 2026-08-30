import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import DocumentTemplateForm from '../components/DocumentTemplateForm'
import ConfirmDeleteButton from '../components/ConfirmDeleteButton'
import AttachmentPreview from '../components/AttachmentPreview'
import { IconDownload } from '../components/Icons'
import {
  fetchDocuments,
  fetchDocumentCategories,
  deleteDocument,
  downloadDocument,
  getDocumentPreviewUrl,
  attachDocumentPdf,
} from '../lib/documents'
import { formatBytes } from '../lib/imageResize'
import { formatDate } from '../lib/format'
import { getCurrentUser, isLimitedRole } from '../lib/auth'
import './DocumentTemplates.css'
// AttachmentPreview（プレビューモーダル）の見た目は本来タスク管理側の KanbanBoard.css で
// 定義されており、日報等を経由せずこの画面を直接開いた場合はまだ読み込まれていないことが
// あるため、ここでも明示的に import しておく（Inspections.jsx と同じ対応）
import '../components/KanbanBoard.css'

// 拡張子・mimeからプレビュー方法を判定する（プレビュー方式の判定は雛形ファイル全体で
// 共通の考え方。kind==='pdf' のときは呼び出し元が既にPDFと分かっているので無条件でPDF扱い）
function detectPreviewKind(doc, kind) {
  if (kind === 'pdf') return { isPdf: true, isImage: false }
  const ext = (doc.file_ext || '').toLowerCase()
  const isPdf = doc.mime === 'application/pdf' || ext === 'pdf'
  const isImage =
    (doc.mime || '').startsWith('image/') ||
    ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif'].includes(ext)
  return { isPdf, isImage }
}

// 雛形ファイル（業務で使う資料テンプレート）画面（2026-08-30〜）。
// 「登録していつでもダウンロードできる資料置き場」。分類ごとにグループ化し、
// グループ内は資料名称順に並べる。owner・備品出庫限定ロールは閲覧・ダウンロードのみ
// （書き込みはサーバー側でも拒否されるが、UIでもボタン自体を出さない）。
// 原本（Word/Excel等）とは別に、印刷用のPDF版をあわせて登録できる（2026-08-30追加）。
// PDF版がある場合、一覧の主操作（プレビュー）はPDF版を優先して開く
// （雛形ファイルは「定期的に印刷するだけ」の用途が多いため）。
export default function DocumentTemplates() {
  const user = getCurrentUser()
  const readOnly = isLimitedRole(user)

  const [documents, setDocuments] = useState(null)
  const [categories, setCategories] = useState([])
  const [error, setError] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [downloadingId, setDownloadingId] = useState(null)
  const [attachingPdfId, setAttachingPdfId] = useState(null)
  // プレビュー表示中のファイル（{ doc, kind, filename, mimeType, url }）。null なら非表示
  const [preview, setPreview] = useState(null)

  // PDF版の追加・差し替え用の隠しinput。一覧の行ごとに<input>を持たず、
  // クリックされた行のidだけ覚えておいて共有の1個を使い回す
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

  async function handleDownload(doc, kind) {
    setDownloadingId(doc.id)
    setError('')
    try {
      const filename = kind === 'pdf' ? doc.pdf_original_filename : doc.original_filename
      await downloadDocument(doc.id, filename, kind)
    } catch (err) {
      setError(err.message)
    } finally {
      setDownloadingId(null)
    }
  }

  // 一覧の操作アイコン。まずダウンロードではなくプレビュー表示にする。
  // 画像・PDFはアプリ内プレビュー（AttachmentPreview）で開き、それ以外（Word/Excel等、
  // ブラウザに内蔵ビューアが無い形式）は実URL（Content-Disposition: inline）を新規タブで
  // 開き、ブラウザ・OS側の既定アプリでの表示に委ねる（可能な環境ではダウンロードなしで
  // そのまま印刷できる。プロジェクトスキル multi-env-attachment-preview 参照）。
  // ただしデスクトップ版Chrome等、その形式を表示できるビューアを持たないブラウザは
  // inline指定を無視してダウンロードだけ行い、開いたタブは空白のまま残る
  // （実機確認で判明。2026-08-30）。空白タブが残るのは紛らわしいため、遷移後は
  // ダウンロードが始まるのを待ってから自動で閉じる（ダウンロード自体はブラウザの
  // ダウンロードマネージャ側で継続するため、タブを閉じても中断されない）。
  // kind: 'original'（既定）または 'pdf'。PDF版はサーバー側で常にPDFと分かっているため
  // 拡張子・mimeでの判定を経ずに必ずプレビューモーダルへ回す
  async function handleOpen(doc, kind = 'original') {
    setDownloadingId(doc.id)
    setError('')
    const { isPdf, isImage } = detectPreviewKind(doc, kind)
    // 新規タブは非同期処理（トークン発行）の後に window.open() すると、クリックの
    // ユーザー操作から切り離されたとポップアップブロッカーに扱われて弾かれることがある。
    // クリック直後に空タブを同期的に開いておき、URLが揃ってから遷移させる
    // ('noopener'を付けると window.open() の戻り値が null になり、後から
    // location を差し込めなくなるため付けない。開く先はブラウザ・OSに任せる
    // 自ファイルのダウンロード配信であり任意の外部ページではないため問題ない)
    const win = !isPdf && !isImage ? window.open('', '_blank') : null
    try {
      const url = await getDocumentPreviewUrl(doc.id, kind)
      if (isPdf || isImage) {
        const filename = kind === 'pdf' ? doc.pdf_original_filename : doc.original_filename
        // AttachmentPreview自身もmimeTypeで表示方法を判定するため、拡張子だけで
        // PDF/画像と判定した場合（mime列が空/不正確）でもそちらに正しく伝わるよう、
        // 実際のmime値ではなく判定結果を優先した値を渡す
        const previewMime = isPdf ? 'application/pdf' : doc.mime?.startsWith('image/') ? doc.mime : 'image/*'
        setPreview({ doc, kind, filename, mimeType: previewMime, url })
      } else if (win) {
        win.location.href = url
        setTimeout(() => {
          try {
            win.close()
          } catch {
            // 既に閉じられている等は無視してよい
          }
        }, 1500)
      }
    } catch (err) {
      win?.close()
      setError(err.message)
    } finally {
      setDownloadingId(null)
    }
  }

  // 一覧の主操作（プレビュー）。PDF版が登録されていればそちらを優先して開く
  // （雛形ファイルは「定期的に印刷するだけ」の用途が多いため）
  function handleOpenPrimary(doc) {
    return handleOpen(doc, doc.pdf_original_filename ? 'pdf' : 'original')
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
                      <th>備考</th>
                      <th>ファイル情報</th>
                      <th className="is-numeric">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((d) => (
                      <tr key={d.id}>
                        <td className="doc-name">{d.name}</td>
                        <td className="doc-remark">{d.remark || ''}</td>
                        <td className="doc-meta">
                          <span className="doc-meta-file">
                            <span className="doc-meta-file-label">原本</span>
                            <span className="doc-meta-filename">{d.original_filename}</span>
                            <span className="doc-meta-sub">
                              {d.file_ext ? d.file_ext.toUpperCase() : ''}
                              {d.file_size != null ? ` ・ ${formatBytes(d.file_size)}` : ''}
                              {d.file_modified_at ? ` ・ 更新 ${formatDate(d.file_modified_at)}` : ''}
                              {/* PDF版がある場合、主操作がPDF優先になるため原本を開く手段を残す */}
                              {d.pdf_original_filename && (
                                <button
                                  type="button"
                                  className="doc-meta-pdf-action"
                                  onClick={() => handleOpen(d, 'original')}
                                  disabled={downloadingId === d.id}
                                >
                                  開く
                                </button>
                              )}
                            </span>
                          </span>
                          <span className="doc-meta-file">
                            <span className="doc-meta-file-label">PDF</span>
                            {d.pdf_original_filename ? (
                              <span className="doc-meta-sub">
                                {d.pdf_file_size != null ? formatBytes(d.pdf_file_size) : ''}
                                {d.pdf_file_modified_at ? ` ・ 更新 ${formatDate(d.pdf_file_modified_at)}` : ''}
                              </span>
                            ) : (
                              <span className="doc-meta-pdf-missing">未登録</span>
                            )}
                            {!readOnly && (
                              <button
                                type="button"
                                className="doc-meta-pdf-action"
                                onClick={() => handleAddOrReplacePdf(d)}
                                disabled={attachingPdfId === d.id}
                              >
                                {attachingPdfId === d.id ? '登録中…' : d.pdf_original_filename ? '差し替え' : '＋ 追加'}
                              </button>
                            )}
                          </span>
                        </td>
                        <td className="is-numeric doc-actions">
                          <button
                            type="button"
                            className="icon-btn-download"
                            onClick={() => handleOpenPrimary(d)}
                            disabled={downloadingId === d.id}
                            aria-label={`${d.name}をプレビュー`}
                            title="プレビュー"
                          >
                            <IconDownload size={20} />
                          </button>
                          {!readOnly && (
                            <ConfirmDeleteButton
                              onConfirm={() => handleDelete(d.id)}
                              label={`${d.name}を削除`}
                              size={20}
                            />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))
        )}
      </div>

      {/* PDF版の追加・差し替え用。画面に1個だけ置き、行ごとにクリックされたidを
          pendingPdfDocIdRef で覚えておいてから開く */}
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
          attachment={{ filename: preview.filename, mimeType: preview.mimeType }}
          url={preview.url}
          onClose={() => setPreview(null)}
          headerAction={
            <button
              type="button"
              className="attachment-preview-share"
              onClick={() => handleDownload(preview.doc, preview.kind)}
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
