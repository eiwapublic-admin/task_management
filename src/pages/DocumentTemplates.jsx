import { useCallback, useEffect, useMemo, useState } from 'react'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import DocumentTemplateForm from '../components/DocumentTemplateForm'
import ConfirmDeleteButton from '../components/ConfirmDeleteButton'
import { IconDownload } from '../components/Icons'
import { fetchDocuments, fetchDocumentCategories, deleteDocument, downloadDocument } from '../lib/documents'
import { formatBytes } from '../lib/imageResize'
import { formatDate } from '../lib/format'
import { getCurrentUser, isLimitedRole } from '../lib/auth'
import './DocumentTemplates.css'

// 雛形ファイル（業務で使う資料テンプレート）画面（2026-08-30〜）。
// 「登録していつでもダウンロードできる資料置き場」。分類ごとにグループ化し、
// グループ内は資料名称順に並べる。owner・備品出庫限定ロールは閲覧・ダウンロードのみ
// （書き込みはサーバー側でも拒否されるが、UIでもボタン自体を出さない）
export default function DocumentTemplates() {
  const user = getCurrentUser()
  const readOnly = isLimitedRole(user)

  const [documents, setDocuments] = useState(null)
  const [categories, setCategories] = useState([])
  const [error, setError] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [downloadingId, setDownloadingId] = useState(null)

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

  async function handleDownload(doc) {
    setDownloadingId(doc.id)
    setError('')
    try {
      await downloadDocument(doc.id, doc.original_filename)
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
                          <span className="doc-meta-filename">{d.original_filename}</span>
                          <span className="doc-meta-sub">
                            {d.file_ext ? d.file_ext.toUpperCase() : ''}
                            {d.file_size != null ? ` ・ ${formatBytes(d.file_size)}` : ''}
                            {d.file_modified_at ? ` ・ 更新 ${formatDate(d.file_modified_at)}` : ''}
                          </span>
                        </td>
                        <td className="is-numeric doc-actions">
                          <button
                            type="button"
                            className="icon-btn-download"
                            onClick={() => handleDownload(d)}
                            disabled={downloadingId === d.id}
                            aria-label={`${d.name}をダウンロード`}
                            title="ダウンロード"
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

      {formOpen && (
        <DocumentTemplateForm categories={categories} onClose={() => setFormOpen(false)} onSaved={handleSaved} />
      )}
    </div>
  )
}
