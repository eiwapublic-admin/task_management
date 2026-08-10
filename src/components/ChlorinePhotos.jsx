import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchChlorinePhotos, uploadPhoto, deletePhoto, fetchPhotoObjectUrl } from '../lib/reports'
import { prepareImage, formatMB } from '../lib/imageResize'
import { formatDateTime } from '../lib/format'
import ConfirmDeleteButton from './ConfirmDeleteButton'

// モバイル判定の分岐点。Dashboard.css の @media (max-width: 640px) と揃える
const MOBILE_QUERY = '(max-width: 640px)'

// 残留塩素等検査の「測定写真」（検査薬の色変化を残す）。日報の作業写真（ReportPhotos）と
// 違い、日報単位ではなく検査レコード単位で持つ（report_photos.chlorine_id で紐付け）。
//
// 新規登録中はまだ検査レコードが無い（保存して初めて id が決まる）ため、選んだ写真は
// いったん端末内に保持して見た目だけ先に出し、保存時に親（ChlorineForm）がまとめて
// アップロードする。これにより「キャンセルしたのに写真だけ残る」ことが起きない。
//
// props:
//   chlorineId / reportId … 保存済みレコードのとき。null なら新規登録中
//   pending                … 新規登録中に選んだ写真（[{ key, file, url, size }]）
//   onPendingChange        … pending の更新（新規登録中のみ使う）
export default function ChlorinePhotos({ chlorineId, reportId, readOnly, pending, onPendingChange }) {
  const [photos, setPhotos] = useState([])
  const [urls, setUrls] = useState({}) // photo.id -> Blob URL
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
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
    if (!chlorineId) {
      setPhotos([])
      return
    }
    try {
      setPhotos(await fetchChlorinePhotos(chlorineId))
    } catch (err) {
      setError(err.message)
    }
  }, [chlorineId])

  useEffect(() => {
    load()
  }, [load])

  // 保存済みの写真の本体を取得して表示する（サムネイルは持たない用途のため本体をそのまま使う）
  useEffect(() => {
    let cancelled = false
    for (const p of photos) {
      if (urls[p.id]) continue
      fetchPhotoObjectUrl(p.id)
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

  // アンマウント時に Blob URL をまとめて解放する（保存済み分・保留中分の両方）
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
    setBusy(true)
    for (const file of files) {
      try {
        const prepared = await prepareImage(file, 'chlorine')
        const takenAt = file.lastModified ? new Date(file.lastModified).toISOString() : null
        if (chlorineId && reportId) {
          const photo = await uploadPhoto({
            reportId,
            category: 'chlorine',
            chlorineId,
            file: prepared.file,
            filename: file.name,
            width: prepared.width,
            height: prepared.height,
            takenAt,
          })
          setPhotos((prev) => [...prev, photo])
        } else {
          // 新規登録中。保存時にアップロードできるよう、縮小済みのファイルを保持しておく
          const url = URL.createObjectURL(prepared.file)
          createdUrls.current.add(url)
          onPendingChange([
            ...pending,
            {
              key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
              file: prepared.file,
              filename: file.name,
              width: prepared.width,
              height: prepared.height,
              takenAt,
              size: prepared.file.size,
              url,
            },
          ])
        }
      } catch (err) {
        setError(err.message)
      }
    }
    setBusy(false)
  }

  async function handleDeleteSaved(id) {
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

  function handleRemovePending(key) {
    const target = pending.find((p) => p.key === key)
    if (target?.url) {
      URL.revokeObjectURL(target.url)
      createdUrls.current.delete(target.url)
    }
    onPendingChange(pending.filter((p) => p.key !== key))
  }

  const tiles = [
    ...photos.map((p) => ({
      key: p.id,
      url: urls[p.id],
      size: p.size,
      takenAt: p.taken_at,
      onDelete: () => handleDeleteSaved(p.id),
    })),
    ...pending.map((p) => ({
      key: p.key,
      url: p.url,
      size: p.size,
      takenAt: p.takenAt,
      isPending: true,
      onDelete: () => handleRemovePending(p.key),
    })),
  ]

  return (
    <div className="chlorine-photos">
      <span className="chlorine-photos-label">測定写真</span>

      {error && (
        <p className="dashboard-error dashboard-banner" role="alert">
          {error}
        </p>
      )}

      <ul className="photo-grid chlorine-photo-grid">
        {tiles.map((t) => (
          <li className="photo-item" key={t.key}>
            <div className="chlorine-photo-row">
              <div className="photo-thumb chlorine-photo-thumb">
                {t.url ? <img src={t.url} alt="測定写真" /> : <span className="photo-loading">読み込み中…</span>}
              </div>
              {!readOnly && (
                <div className="chlorine-photo-actions">
                  <ConfirmDeleteButton onConfirm={t.onDelete} label="この写真を削除" size={22} />
                </div>
              )}
            </div>
            <div className="photo-meta">
              {t.size > 0 && <span>{formatMB(t.size)}</span>}
              {t.takenAt && <span>{formatDateTime(t.takenAt)}</span>}
              {t.isPending && <span className="chlorine-photo-pending">保存時に登録</span>}
            </div>
          </li>
        ))}
        {!readOnly && (
          <li className="photo-item photo-add-item">
            {/* capture 指定でスマホのカメラを直接起動する（現場では撮影が主な導線） */}
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
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                handleFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <div className="chlorine-photo-add">
              <button
                type="button"
                className="btn-plain"
                onClick={() => cameraRef.current?.click()}
                disabled={busy}
              >
                {busy ? '処理中…' : '撮影'}
              </button>
              <button
                type="button"
                className="btn-plain"
                onClick={() => fileRef.current?.click()}
                disabled={busy}
              >
                ファイルから選ぶ
              </button>
            </div>
          </li>
        )}
      </ul>
      {!readOnly && tiles.length === 0 && (
        <p className="settings-hint">
          {isMobile ? '「撮影」で検査薬の色を撮影して記録できます。' : 'アップロード時に自動で縮小されます。'}
        </p>
      )}
    </div>
  )
}
