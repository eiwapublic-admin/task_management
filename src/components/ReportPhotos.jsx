import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchPhotos,
  uploadPhoto,
  updatePhotoComment,
  deletePhoto,
  fetchPhotoObjectUrl,
} from '../lib/reports'
import { prepareImage, formatBytes, formatMB } from '../lib/imageResize'
import { formatDateTime } from '../lib/format'
import ConfirmDeleteButton from './ConfirmDeleteButton'
import { IconDownload, IconCamera, IconFolder } from './Icons'

// モバイル判定の分岐点。Dashboard.css の @media (max-width: 640px) と揃える
const MOBILE_QUERY = '(max-width: 640px)'

// 日報の写真。撮影/選択 → 自動縮小 → アップロード → コメント入力までをこの中で完結させる。
// 保管容量を抑えるため、送信前にブラウザ側で縮小する（docs/daily-report-plan.md 4-3）。
export default function ReportPhotos({ reportId, readOnly }) {
  const [photos, setPhotos] = useState([])
  const [urls, setUrls] = useState({}) // photo.id -> Blob URL
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(0)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(null) // 拡大表示中の写真
  const [dragOver, setDragOver] = useState(false)
  // モバイルでは同じボタンが「撮影して追加」になる（2026-08-05）。
  // ドラッグ＆ドロップの空枠はPC向けなので、モバイルではボタンだけが頼り。
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches)
  const cameraRef = useRef(null)
  const fileRef = useRef(null)
  // 解放漏れを防ぐため、作成した Blob URL を全て覚えておく
  const createdUrls = useRef(new Set())

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY)
    const onChange = () => setIsMobile(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  const load = useCallback(async () => {
    try {
      const list = await fetchPhotos(reportId, 'work')
      setPhotos(list)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [reportId])

  useEffect(() => {
    load()
  }, [load])

  // 一覧に出す画像を取得する。サムネイルがあればそれを使い、無ければ本体を使う
  useEffect(() => {
    let cancelled = false
    for (const p of photos) {
      if (urls[p.id]) continue
      fetchPhotoObjectUrl(p.id, { thumb: Boolean(p.thumb_key) })
        .then((url) => {
          if (cancelled) {
            URL.revokeObjectURL(url)
            return
          }
          createdUrls.current.add(url)
          setUrls((prev) => ({ ...prev, [p.id]: url }))
        })
        .catch(() => {}) // 1枚取れなくても他の表示は続ける
    }
    return () => {
      cancelled = true
    }
  }, [photos, urls])

  // アンマウント時に Blob URL をまとめて解放する
  useEffect(() => {
    const set = createdUrls.current
    return () => {
      for (const url of set) URL.revokeObjectURL(url)
      set.clear()
    }
  }, [])

  async function handleFiles(fileList) {
    const files = Array.from(fileList || [])
    if (files.length === 0) return
    setError('')
    setUploading(files.length)
    for (const file of files) {
      try {
        const prepared = await prepareImage(file, 'work')
        const photo = await uploadPhoto({
          reportId,
          category: 'work',
          file: prepared.file,
          thumb: prepared.thumb,
          filename: file.name,
          width: prepared.width,
          height: prepared.height,
          // 撮影日時は端末のファイル更新時刻で代用する（EXIF解析は依存を増やすため見送り）
          takenAt: file.lastModified ? new Date(file.lastModified).toISOString() : null,
        })
        setPhotos((prev) => [...prev, photo])
      } catch (err) {
        setError(err.message)
      } finally {
        setUploading((n) => Math.max(n - 1, 0))
      }
    }
  }

  async function handleComment(id, comment) {
    setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, comment } : p)))
    try {
      await updatePhotoComment(id, comment)
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleDelete(id) {
    setPhotos((prev) => prev.filter((p) => p.id !== id))
    const url = urls[id]
    if (url) {
      URL.revokeObjectURL(url)
      createdUrls.current.delete(url)
      setUrls((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    }
    try {
      await deletePhoto(id)
    } catch (err) {
      setError(err.message)
      load()
    }
  }

  const totalBytes = photos.reduce((sum, p) => sum + (p.size || 0), 0)

  return (
    <section className="report-card">
      <h3 className="report-card-title">
        写真
        <span className="report-count">
          {photos.length} 枚{totalBytes > 0 && `・${formatBytes(totalBytes)}`}
        </span>
      </h3>

      {error && (
        <p className="dashboard-error dashboard-banner" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p className="dashboard-loading">読み込み中…</p>
      ) : (
        <>
          {photos.length === 0 && !uploading && <p className="settings-hint">まだ写真がありません。</p>}

          <ul className="photo-grid">
            {photos.map((p) => (
              <li className="photo-item" key={p.id}>
                <button
                  type="button"
                  className="photo-thumb"
                  onClick={() => setPreview(p)}
                  aria-label="写真を拡大"
                >
                  {urls[p.id] ? (
                    <img src={urls[p.id]} alt={p.comment || p.filename || '作業写真'} />
                  ) : (
                    <span className="photo-loading">読み込み中…</span>
                  )}
                </button>
                {/* 縮小後のファイルサイズ（MB）と撮影/変更日時。写真の下に表示する（2026-08-05） */}
                {(p.size > 0 || p.taken_at) && (
                  <div className="photo-meta">
                    {p.size > 0 && <span>{formatMB(p.size)}</span>}
                    {p.taken_at && <span>{formatDateTime(p.taken_at)}</span>}
                  </div>
                )}
                <textarea
                  className="photo-comment"
                  rows={2}
                  value={p.comment || ''}
                  placeholder="コメント"
                  disabled={readOnly}
                  onChange={(e) => handleComment(p.id, e.target.value)}
                  aria-label="写真のコメント"
                />
              </li>
            ))}
            {uploading > 0 && (
              <li className="photo-item">
                <div className="photo-thumb photo-uploading">
                  <span>アップロード中… ({uploading})</span>
                </div>
              </li>
            )}
            {!readOnly && (
              <li className="photo-item photo-add-item">
                {/* 空枠にドラッグ＆ドロップで登録できる（PC向け）。写真を追加するたびに
                    この枠が末尾に残るので、連続して追加できる（2026-08-05） */}
                <div
                  className={`photo-dropzone${dragOver ? ' is-dragover' : ''}`}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDragOver(true)
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragOver(false)
                    handleFiles(e.dataTransfer.files)
                  }}
                >
                  <span className="photo-dropzone-hint">ここにドラッグ＆ドロップ</span>
                </div>
                {/* capture 指定でスマホのカメラを直接起動する */}
                <input
                  ref={cameraRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  hidden
                  onChange={(e) => {
                    handleFiles(e.target.files)
                    e.target.value = ''
                  }}
                />
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*,application/pdf"
                  multiple
                  hidden
                  onChange={(e) => {
                    handleFiles(e.target.files)
                    e.target.value = ''
                  }}
                />
                {isMobile ? (
                  // モバイルは撮影・ライブラリ選択の両方を出す（2026-08-26。以前は撮影のみで
                  // 写真ライブラリから選べなかった）。2026-09-02: 残留塩素の測定写真ボタンと
                  // 同じアイコン（撮影＝カメラ、ライブラリ＝フォルダ）に揃えた
                  <div className="photo-add-icon-row">
                    <button
                      type="button"
                      className="icon-btn-camera"
                      onClick={() => cameraRef.current?.click()}
                      aria-label="撮影して追加"
                      title="撮影して追加"
                    >
                      <IconCamera size={20} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn-folder"
                      onClick={() => fileRef.current?.click()}
                      aria-label="ライブラリから選ぶ"
                      title="ライブラリから選ぶ"
                    >
                      <IconFolder size={20} />
                    </button>
                  </div>
                ) : (
                  <button type="button" className="btn-plain photo-add-btn" onClick={() => fileRef.current?.click()}>
                    ファイルから選ぶ
                  </button>
                )}
              </li>
            )}
          </ul>

          {!readOnly && (
            <p className="settings-hint photo-hint">
              アップロード時に自動で縮小されます（保管容量の節約のため）
            </p>
          )}
        </>
      )}

      {preview && (
        <PhotoPreview
          photo={preview}
          onClose={() => setPreview(null)}
          onDelete={
            readOnly
              ? undefined
              : async () => {
                  await handleDelete(preview.id)
                  setPreview(null)
                }
          }
        />
      )}
    </section>
  )
}

// 拡大表示。原本（縮小済みの本体）を改めて取得して表示する。
// 削除ボタンはここに置く（一覧の狭いタイルではなく、拡大して確認してから消せるように）。
function PhotoPreview({ photo, onClose, onDelete }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let objectUrl = ''
    let cancelled = false
    fetchPhotoObjectUrl(photo.id)
      .then((u) => {
        if (cancelled) {
          URL.revokeObjectURL(u)
          return
        }
        objectUrl = u
        setUrl(u)
      })
      .catch((err) => setError(err.message))
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [photo.id])

  // Esc で閉じる
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="photo-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="photo-overlay-inner" onClick={(e) => e.stopPropagation()}>
        {/* 暗い背景の上に載るボタンなので、明るい面の icon-btn-close ではなく
            白丸に濃色の×を使う専用スタイル（photo-overlay-close）のままにする */}
        <button type="button" className="photo-overlay-close" onClick={onClose} aria-label="閉じる">
          ×
        </button>
        {error ? (
          <p className="dashboard-error">{error}</p>
        ) : url ? (
          <img src={url} alt={photo.comment || photo.filename || '作業写真'} />
        ) : (
          <p className="dashboard-loading">読み込み中…</p>
        )}
        {photo.comment && <p className="photo-overlay-caption">{photo.comment}</p>}
        {(url || onDelete) && (
          <div className="photo-overlay-actions">
            <div className="photo-overlay-actions-right">
              {url && (
                <a
                  className="icon-btn-download icon-btn-download-dark"
                  href={url}
                  download={photo.filename || 'photo.jpg'}
                  aria-label="写真をダウンロード"
                  title="ダウンロード"
                >
                  <IconDownload size={24} />
                </a>
              )}
              {onDelete && <ConfirmDeleteButton onConfirm={onDelete} label="この写真を削除" size={24} dark />}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
