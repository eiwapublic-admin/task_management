import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import DocumentTemplateForm from '../components/DocumentTemplateForm'
import AttachmentPreview from '../components/AttachmentPreview'
import { IconDownload, IconSearch } from '../components/Icons'
import {
  fetchDocuments,
  fetchDocumentCategories,
  deleteDocument,
  downloadDocument,
  getDocumentPreviewUrl,
  fetchDocumentThumbnailUrl,
  getEffectivePdf,
} from '../lib/documents'
import { formatDate } from '../lib/format'
import { getCurrentUser, isLimitedRole } from '../lib/auth'
import './DocumentTemplates.css'
// AttachmentPreview（PDFのプレビューモーダル）の見た目は本来タスク管理側の KanbanBoard.css で
// 定義されており、日報等を経由せずこの画面を直接開いた場合はまだ読み込まれていないことが
// あるため、ここでも明示的に import しておく（Inspections.jsx と同じ対応）
import '../components/KanbanBoard.css'

// 雛形ファイル（業務で使う資料テンプレート）画面（2026-08-30〜）。
// 「登録していつでもダウンロードできる資料置き場」。分類ごとにグループ化し、
// グループ内は資料名称順に並べる。owner・備品出庫限定ロールは閲覧・ダウンロードのみ
// （書き込みはサーバー側でも拒否されるが、UIでもボタン自体を出さない）。
//
// 一覧はカード型で表示する（2026-08-31の依頼によるレイアウト変更。以前は表形式だった）。
// カードをクリックすると登録画面と同じフォーム（DocumentTemplateForm）を編集モードで開き、
// 原本・PDF版・サムネイルの差し替えも含めてそこで行う。カード自体には追加や差し替えの
// ボタンは置かず、PDFプレビュー・原本ダウンロードの2つのボタンだけを持つ
// （クリックはstopPropagationしてカード自体のクリック＝編集起動と分離する）。
export default function DocumentTemplates() {
  const user = getCurrentUser()
  const readOnly = isLimitedRole(user)

  const [documents, setDocuments] = useState(null)
  const [categories, setCategories] = useState([])
  const [error, setError] = useState('')
  const [showNewForm, setShowNewForm] = useState(false)
  const [activeDoc, setActiveDoc] = useState(null)
  const [downloadingId, setDownloadingId] = useState(null)
  // プレビュー表示中のファイル（{ doc, kind, filename, url }）。null なら非表示
  const [preview, setPreview] = useState(null)

  // カードのサムネイル画像（doc.id -> Blob URL）。非公開バケットのため認証付きで
  // 取得する必要があり、日報写真の一覧（ReportPhotos.jsx）と同じ方式にする
  const [thumbUrls, setThumbUrls] = useState({})
  const createdThumbUrls = useRef(new Set())

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

  useEffect(() => {
    if (!documents) return
    let cancelled = false
    for (const d of documents) {
      if (!d.has_thumbnail || thumbUrls[d.id]) continue
      fetchDocumentThumbnailUrl(d.id)
        .then((url) => {
          if (cancelled) {
            URL.revokeObjectURL(url)
            return
          }
          createdThumbUrls.current.add(url)
          setThumbUrls((prev) => ({ ...prev, [d.id]: url }))
        })
        .catch(() => {}) // 1枚取れなくても他の表示は続ける
    }
    return () => {
      cancelled = true
    }
  }, [documents, thumbUrls])

  // アンマウント時に Blob URL をまとめて解放する
  useEffect(() => {
    const set = createdThumbUrls.current
    return () => {
      for (const url of set) URL.revokeObjectURL(url)
      set.clear()
    }
  }, [])

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

  // サムネイルのキャッシュ済みURLを破棄する（差し替え・削除で古い画像を出さないようにする）
  function invalidateThumb(id) {
    setThumbUrls((prev) => {
      const url = prev[id]
      if (!url) return prev
      URL.revokeObjectURL(url)
      createdThumbUrls.current.delete(url)
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  async function handleDelete(id) {
    setError('')
    try {
      await deleteDocument(id)
      setDocuments((prev) => prev.filter((d) => d.id !== id))
      invalidateThumb(id)
      setActiveDoc(null)
    } catch (err) {
      setError(err.message)
    }
  }

  function handleSaved(doc) {
    setShowNewForm(false)
    setActiveDoc(null)
    setDocuments((prev) => (prev.some((d) => d.id === doc.id) ? prev.map((d) => (d.id === doc.id ? doc : d)) : [...prev, doc]))
    setCategories((prev) => (prev.includes(doc.category) ? prev : [doc.category, ...prev]))
    invalidateThumb(doc.id) // 原本・PDF版・サムネイルが変わっている可能性があるため再取得させる
  }

  function renderCard(d) {
    const effectivePdf = getEffectivePdf(d)
    return (
      <div
        className="doc-card"
        key={d.id}
        role="button"
        tabIndex={0}
        onClick={() => setActiveDoc(d)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setActiveDoc(d)
          }
        }}
      >
        <div className="doc-card-main">
          <div className="doc-card-name">{d.name}</div>
          {d.remark && <p className="doc-card-remark">{d.remark}</p>}
        </div>

        <div className="doc-card-files">
          <div className="doc-card-file-row">
            {effectivePdf ? (
              <>
                <button
                  type="button"
                  className="doc-btn-pdf"
                  onClick={(e) => {
                    e.stopPropagation()
                    handlePreviewPdf(d, effectivePdf)
                  }}
                  disabled={downloadingId === d.id}
                  title={effectivePdf.filename}
                >
                  <IconSearch size={12} />
                  PDF
                </button>
                {d.pdf_file_modified_at && <span className="doc-file-date">{formatDate(d.pdf_file_modified_at)}</span>}
              </>
            ) : (
              <span className="doc-pdf-missing">未登録</span>
            )}
          </div>
          <div className="doc-card-file-row">
            <button
              type="button"
              className="doc-btn-original"
              onClick={(e) => {
                e.stopPropagation()
                handleDownloadOriginal(d)
              }}
              disabled={downloadingId === d.id}
              title={d.original_filename}
            >
              <IconDownload size={12} />
              {(d.file_ext || 'FILE').toUpperCase()}
            </button>
            {d.file_modified_at && <span className="doc-file-date">{formatDate(d.file_modified_at)}</span>}
          </div>
        </div>

        <div className="doc-card-thumb">
          {thumbUrls[d.id] ? (
            <img src={thumbUrls[d.id]} alt="" />
          ) : (
            <span className="doc-thumb-placeholder">サムネ</span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="ui-page">
      <AppHeader />
      {/* PCではウインドウ幅を十分に使う（2026-08-31。カード型に変更したのに伴い、
          違反車両一覧と同じ全幅表示にしてほしいとの依頼） */}
      <div className="ui-container app-scroll">
        <FeatureHeader
          actions={
            !readOnly && (
              <button type="button" className="btn-primary" onClick={() => setShowNewForm(true)}>
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
              <div className="doc-group-band">
                {g.category}
                <span className="doc-group-band-count">{g.rows.length}件</span>
              </div>
              <div className="doc-cards">{g.rows.map(renderCard)}</div>
            </section>
          ))
        )}
      </div>

      {showNewForm && (
        <DocumentTemplateForm categories={categories} onClose={() => setShowNewForm(false)} onSaved={handleSaved} />
      )}

      {activeDoc && (
        <DocumentTemplateForm
          doc={activeDoc}
          categories={categories}
          readOnly={readOnly}
          onClose={() => setActiveDoc(null)}
          onSaved={handleSaved}
          onDelete={handleDelete}
        />
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
