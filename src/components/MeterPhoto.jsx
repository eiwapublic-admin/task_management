import { useEffect, useState } from 'react'
import { fetchMeterPhotoBlob } from '../lib/meter'

// 検針写真を1枚表示する（2026-10-20〜）。バケットは非公開なので API から Blob で取って表示する。
// onClick を渡すと押せる（拡大表示など）
export default function MeterPhoto({ photo, alt = '', className = '', onClick }) {
  const [url, setUrl] = useState(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!photo?.id) return undefined
    let objectUrl = null
    let alive = true
    setFailed(false)
    fetchMeterPhotoBlob(photo.id)
      .then((blob) => {
        if (!alive) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
      setUrl(null)
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [photo?.id])

  if (!photo) return <div className={`meter-photo is-empty ${className}`}>写真なし</div>
  if (failed) return <div className={`meter-photo is-empty ${className}`}>読み込めませんでした</div>
  const img = url ? <img src={url} alt={alt} /> : <span className="meter-photo-loading">…</span>
  return onClick ? (
    <button type="button" className={`meter-photo ${className}`} onClick={onClick} aria-label="写真を拡大">
      {img}
    </button>
  ) : (
    <div className={`meter-photo ${className}`}>{img}</div>
  )
}
