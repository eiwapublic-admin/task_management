import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchParkingViolations,
  createParkingViolation,
  updateParkingViolation,
  deleteParkingViolation,
  fetchPhotos,
  uploadPhoto,
  fetchPhotoObjectUrl,
  VIOLATION_LABELS,
} from '../lib/reports'
import { prepareImage } from '../lib/imageResize'
import ConfirmDeleteButton from './ConfirmDeleteButton'

// モバイル判定の分岐点。Dashboard.css の @media (max-width: 640px) と揃える
const MOBILE_QUERY = '(max-width: 640px)'
// 項目の入力は自動保存する（作業記録の明細と同じ考え方）
const AUTOSAVE_MS = 800

// 違反車両の登録。写真セクションと同じ「空枠にドラッグ＆ドロップ/撮影」の流れで、
// 1枚の写真＝1件の記録として登録し、その場でナンバー等の項目を入力できるようにする。
// 一覧は日を跨って見られるよう別画面（/reports/parking）に分けている（このセクションは当日分のみ）。
export default function ReportParkingViolations({ reportId, readOnly }) {
  const [violations, setViolations] = useState([])
  const [photosByViolation, setPhotosByViolation] = useState({}) // violation.id -> photo
  const [urls, setUrls] = useState({}) // photo.id -> Blob URL
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches)
  const cameraRef = useRef(null)
  const fileRef = useRef(null)
  const createdUrls = useRef(new Set())
  const timers = useRef(new Map())

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY)
    const onChange = () => setIsMobile(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [list, photos] = await Promise.all([
        fetchParkingViolations({ reportId }),
        fetchPhotos(reportId, 'parking'),
      ])
      setViolations(list)
      const byViolation = {}
      for (const p of photos) {
        if (p.parking_id) byViolation[p.parking_id] = p
      }
      setPhotosByViolation(byViolation)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [reportId])

  useEffect(() => {
    load()
  }, [load])

  // 一覧に出す画像を取得する（サムネイルがあればそれを使う）
  useEffect(() => {
    let cancelled = false
    for (const p of Object.values(photosByViolation)) {
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
        .catch(() => {})
    }
    return () => {
      cancelled = true
    }
  }, [photosByViolation, urls])

  useEffect(() => {
    const set = createdUrls.current
    return () => {
      for (const url of set) URL.revokeObjectURL(url)
      set.clear()
    }
  }, [])

  useEffect(() => {
    const map = timers.current
    return () => {
      for (const t of map.values()) clearTimeout(t)
      map.clear()
    }
  }, [])

  // 写真1枚＝違反車両1件として登録する。まずレコードを作り、そこへ写真を紐付ける
  async function handleAddFromFile(fileList) {
    const files = Array.from(fileList || [])
    if (files.length === 0) return
    setError('')
    setUploading(true)
    let violation = null
    try {
      violation = await createParkingViolation({ report_id: reportId })
      setViolations((prev) => [violation, ...prev])
      const file = files[0]
      const prepared = await prepareImage(file, 'parking')
      const photo = await uploadPhoto({
        reportId,
        category: 'parking',
        parkingId: violation.id,
        file: prepared.file,
        thumb: prepared.thumb,
        filename: file.name,
        width: prepared.width,
        height: prepared.height,
        takenAt: file.lastModified ? new Date(file.lastModified).toISOString() : null,
      })
      setPhotosByViolation((prev) => ({ ...prev, [violation.id]: photo }))
    } catch (err) {
      setError(err.message)
      // 写真の保存に失敗した場合、空のレコードだけが残らないよう取り消す
      if (violation) {
        setViolations((prev) => prev.filter((v) => v.id !== violation.id))
        deleteParkingViolation(violation.id).catch(() => {})
      }
    } finally {
      setUploading(false)
    }
  }

  // 入力中は画面の値だけ更新し、少し待ってからまとめて保存する
  function patchViolation(id, patch) {
    if (readOnly) return
    setViolations((prev) => prev.map((v) => (v.id === id ? { ...v, ...patch } : v)))
    const timer = timers.current.get(id)
    if (timer) clearTimeout(timer)
    timers.current.set(
      id,
      setTimeout(async () => {
        timers.current.delete(id)
        try {
          await updateParkingViolation(id, patch)
        } catch (err) {
          setError(err.message)
        }
      }, AUTOSAVE_MS)
    )
  }

  function toggleViolationType(v, type) {
    const has = v.violations.includes(type)
    const next = has ? v.violations.filter((t) => t !== type) : [...v.violations, type]
    patchViolation(v.id, { violations: next })
  }

  async function handleDelete(id) {
    setViolations((prev) => prev.filter((v) => v.id !== id))
    setPhotosByViolation((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    try {
      await deleteParkingViolation(id)
    } catch (err) {
      setError(err.message)
      load()
    }
  }

  return (
    <section className="report-card">
      <h3 className="report-card-title">
        違反車両
        <span className="report-count">{violations.length} 件</span>
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
          {violations.length === 0 && !uploading && <p className="settings-hint">まだ記録がありません。</p>}

          <ul className="parking-grid">
            {violations.map((v) => {
              const photo = photosByViolation[v.id]
              return (
                <li className="parking-card" key={v.id}>
                  <div className="parking-card-photo">
                    {photo ? (
                      urls[photo.id] ? (
                        <img src={urls[photo.id]} alt="違反車両の写真" />
                      ) : (
                        <span className="photo-loading">読み込み中…</span>
                      )
                    ) : (
                      <span className="photo-loading">写真なし</span>
                    )}
                  </div>
                  <div className="parking-card-fields">
                    <div className="parking-card-row">
                      <input
                        type="text"
                        placeholder="地域"
                        value={v.plate_region || ''}
                        disabled={readOnly}
                        onChange={(e) => patchViolation(v.id, { plate_region: e.target.value })}
                        aria-label="ナンバーの地域"
                      />
                      <input
                        type="text"
                        placeholder="ナンバー"
                        value={v.plate_number || ''}
                        disabled={readOnly}
                        onChange={(e) => patchViolation(v.id, { plate_number: e.target.value })}
                        aria-label="ナンバー"
                      />
                    </div>
                    <div className="parking-card-row">
                      <input
                        type="text"
                        placeholder="メーカー"
                        value={v.maker || ''}
                        disabled={readOnly}
                        onChange={(e) => patchViolation(v.id, { maker: e.target.value })}
                        aria-label="メーカー"
                      />
                      <input
                        type="text"
                        placeholder="車種"
                        value={v.model || ''}
                        disabled={readOnly}
                        onChange={(e) => patchViolation(v.id, { model: e.target.value })}
                        aria-label="車種"
                      />
                    </div>
                    <input
                      type="text"
                      placeholder="所有会社・訪問先"
                      value={v.owner_company || ''}
                      disabled={readOnly}
                      onChange={(e) => patchViolation(v.id, { owner_company: e.target.value })}
                      aria-label="所有会社・訪問先"
                    />
                    <div className="parking-card-violations">
                      {Object.entries(VIOLATION_LABELS).map(([key, label]) => (
                        <label key={key} className="parking-violation-chip">
                          <input
                            type="checkbox"
                            checked={v.violations.includes(key)}
                            disabled={readOnly}
                            onChange={() => toggleViolationType(v, key)}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                    <textarea
                      className="parking-card-note"
                      rows={2}
                      placeholder="補足"
                      value={v.note || ''}
                      disabled={readOnly}
                      onChange={(e) => patchViolation(v.id, { note: e.target.value })}
                      aria-label="補足"
                    />
                  </div>
                  {!readOnly && (
                    <ConfirmDeleteButton onConfirm={() => handleDelete(v.id)} label="この記録を削除" size={16} />
                  )}
                </li>
              )
            })}
            {!readOnly && (
              <li className="parking-card parking-add-item">
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
                    handleAddFromFile(e.dataTransfer.files)
                  }}
                >
                  <span className="photo-dropzone-hint">ここにドラッグ＆ドロップ</span>
                </div>
                <input
                  ref={cameraRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  hidden
                  onChange={(e) => {
                    handleAddFromFile(e.target.files)
                    e.target.value = ''
                  }}
                />
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    handleAddFromFile(e.target.files)
                    e.target.value = ''
                  }}
                />
                <button
                  type="button"
                  className="btn-plain photo-add-btn"
                  disabled={uploading}
                  onClick={() => (isMobile ? cameraRef : fileRef).current?.click()}
                >
                  {uploading ? '追加中…' : isMobile ? '撮影して追加' : 'ファイルから選ぶ'}
                </button>
              </li>
            )}
          </ul>
        </>
      )}
    </section>
  )
}
