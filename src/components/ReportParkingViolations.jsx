import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchParkingViolations,
  createParkingViolation,
  updateParkingViolation,
  deleteParkingViolation,
  recognizeParkingPhoto,
  fetchPhotos,
  uploadPhoto,
  deletePhoto,
  fetchPhotoObjectUrl,
  VIOLATION_LABELS,
} from '../lib/reports'
import { prepareImage, formatMB } from '../lib/imageResize'
import { formatDateTime } from '../lib/format'
import ConfirmDeleteButton from './ConfirmDeleteButton'
import { IconDownload } from './Icons'

// モバイル判定の分岐点。Dashboard.css の @media (max-width: 640px) と揃える
const MOBILE_QUERY = '(max-width: 640px)'
// 項目の入力は自動保存する（作業記録の明細と同じ考え方）
const AUTOSAVE_MS = 800
// 1件につき写真は2枚まで（車両全体＋ナンバー拡大 等）
const MAX_PHOTOS = 2

function uniqueSorted(list) {
  return [...new Set(list.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'))
}

// ナンバーは数字4桁のみを保持する（「-」等の区切り文字は除去。2026-08-05）
function sanitizePlateNumber(value) {
  return (value || '').replace(/\D/g, '').slice(0, 4)
}

// 違反車両の登録。写真セクションと同じ「空枠にドラッグ＆ドロップ/撮影」の流れで、
// 1件につき写真2枚まで登録し、その場でナンバー等の項目を入力できるようにする。
// 一覧は日を跨って見られるよう別画面（/reports/parking）に分けている（このセクションは当日分のみ）。
export default function ReportParkingViolations({ reportId, readOnly }) {
  const [violations, setViolations] = useState([])
  const [photosByViolation, setPhotosByViolation] = useState({}) // violation.id -> photo[]
  const [historical, setHistorical] = useState([]) // 全期間（リスト選択の候補作成用）
  const [urls, setUrls] = useState({}) // photo.id -> Blob URL
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [preview, setPreview] = useState(null) // 拡大表示中の写真 { photo, violationId }
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
        if (!p.parking_id) continue
        if (!byViolation[p.parking_id]) byViolation[p.parking_id] = []
        byViolation[p.parking_id].push(p)
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

  // 地域・ナンバー・メーカー・車種・テナント名をリスト選択できるよう、全期間の履歴を一度だけ取得する
  useEffect(() => {
    fetchParkingViolations()
      .then(setHistorical)
      .catch(() => setHistorical([]))
  }, [])

  const options = useMemo(
    () => ({
      region: uniqueSorted(historical.map((v) => v.plate_region)),
      plate: uniqueSorted(historical.map((v) => v.plate_number)),
      maker: uniqueSorted(historical.map((v) => v.maker)),
      model: uniqueSorted(historical.map((v) => v.model)),
      owner: uniqueSorted(historical.map((v) => v.owner_company)),
    }),
    [historical]
  )

  // 一覧に出す画像を取得する（サムネイルがあればそれを使う）
  useEffect(() => {
    let cancelled = false
    for (const p of Object.values(photosByViolation).flat()) {
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

  // 写真を追加する。violationId が無ければ新規レコードを作ってから紐付ける（＝新規登録）。
  // ある場合はそのレコードへの2枚目として追加する。
  async function handleAddPhoto(fileList, violationId) {
    const files = Array.from(fileList || [])
    if (files.length === 0) return
    setError('')
    setUploading(true)
    let targetId = violationId
    let createdNew = false
    try {
      if (!targetId) {
        const violation = await createParkingViolation({ report_id: reportId })
        setViolations((prev) => [violation, ...prev])
        targetId = violation.id
        createdNew = true
      }
      const file = files[0]
      const prepared = await prepareImage(file, 'parking')
      const photo = await uploadPhoto({
        reportId,
        category: 'parking',
        parkingId: targetId,
        file: prepared.file,
        thumb: prepared.thumb,
        filename: file.name,
        width: prepared.width,
        height: prepared.height,
        takenAt: file.lastModified ? new Date(file.lastModified).toISOString() : null,
      })
      setPhotosByViolation((prev) => ({ ...prev, [targetId]: [...(prev[targetId] || []), photo] }))
    } catch (err) {
      setError(err.message)
      if (createdNew && targetId) {
        setViolations((prev) => prev.filter((v) => v.id !== targetId))
        deleteParkingViolation(targetId).catch(() => {})
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

  async function handleDeleteViolation(id) {
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

  async function handleDeletePhoto(violationId, photoId) {
    setPhotosByViolation((prev) => ({
      ...prev,
      [violationId]: (prev[violationId] || []).filter((p) => p.id !== photoId),
    }))
    const url = urls[photoId]
    if (url) {
      URL.revokeObjectURL(url)
      createdUrls.current.delete(url)
      setUrls((prev) => {
        const next = { ...prev }
        delete next[photoId]
        return next
      })
    }
    try {
      await deletePhoto(photoId)
    } catch (err) {
      setError(err.message)
      load()
    }
  }

  // 写真からナンバー・車種を読み取り、空欄の項目だけに反映する（既存の入力は上書きしない）
  async function handleRecognize(violation, photoId) {
    const result = await recognizeParkingPhoto(photoId)
    const patch = {}
    if (!violation.plate_region && result.plate_region) patch.plate_region = result.plate_region
    if (!violation.plate_number && result.plate_number) patch.plate_number = sanitizePlateNumber(result.plate_number)
    if (!violation.maker && result.maker) patch.maker = result.maker
    if (!violation.model && result.model) patch.model = result.model
    if (Object.keys(patch).length > 0) patchViolation(violation.id, patch)
    return patch
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
            {violations.map((v) => (
              <ParkingCard
                key={v.id}
                violation={v}
                photos={photosByViolation[v.id] || []}
                urls={urls}
                readOnly={readOnly}
                isMobile={isMobile}
                onPatch={(patch) => patchViolation(v.id, patch)}
                onToggleType={(type) => toggleViolationType(v, type)}
                onDelete={() => handleDeleteViolation(v.id)}
                onAddPhoto={(files) => handleAddPhoto(files, v.id)}
                onOpenPreview={(photo) => setPreview({ photo, violationId: v.id })}
              />
            ))}
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
                    handleAddPhoto(e.dataTransfer.files)
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
                    handleAddPhoto(e.target.files)
                    e.target.value = ''
                  }}
                />
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    handleAddPhoto(e.target.files)
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

          {/* 地域・ナンバー・メーカー・車種・テナント名は既存レコードからも選べるようにする（2026-08-05）。
              画面内で一度だけ定義し、各カードの input はこの id を list 属性で参照する
              （カードごとに定義すると id が重複してしまうため）。 */}
          <datalist id="parking-region-options">
            {options.region.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
          <datalist id="parking-plate-options">
            {options.plate.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
          <datalist id="parking-maker-options">
            {options.maker.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
          <datalist id="parking-model-options">
            {options.model.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
          <datalist id="parking-owner-options">
            {options.owner.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </>
      )}

      {preview && (
        <ParkingPhotoPreview
          photo={preview.photo}
          violation={violations.find((v) => v.id === preview.violationId)}
          readOnly={readOnly}
          onClose={() => setPreview(null)}
          onDelete={
            readOnly
              ? undefined
              : async () => {
                  await handleDeletePhoto(preview.violationId, preview.photo.id)
                  setPreview(null)
                }
          }
          onRecognize={
            readOnly
              ? undefined
              : () => handleRecognize(violations.find((v) => v.id === preview.violationId), preview.photo.id)
          }
        />
      )}
    </section>
  )
}

// 違反車両1件分のカード。写真（最大2枚）・項目の入力・削除をまとめる
function ParkingCard({
  violation: v,
  photos,
  urls,
  readOnly,
  isMobile,
  onPatch,
  onToggleType,
  onDelete,
  onAddPhoto,
  onOpenPreview,
}) {
  const cameraRef = useRef(null)
  const fileRef = useRef(null)

  return (
    <li className="parking-card">
      <div className="parking-card-photos">
        {photos.map((photo) => (
          <div className="parking-card-photo-wrap" key={photo.id}>
            <button
              type="button"
              className="parking-card-photo"
              onClick={() => onOpenPreview(photo)}
              aria-label="写真を拡大"
            >
              {urls[photo.id] ? (
                <img src={urls[photo.id]} alt="違反車両の写真" />
              ) : (
                <span className="photo-loading">読み込み中…</span>
              )}
            </button>
            {/* 縮小後のファイルサイズ・撮影/変更日時。作業写真と同様に表示する（2026-08-05） */}
            {(photo.size > 0 || photo.taken_at) && (
              <div className="photo-meta">
                {photo.size > 0 && <span>{formatMB(photo.size)}</span>}
                {photo.taken_at && <span>{formatDateTime(photo.taken_at)}</span>}
              </div>
            )}
          </div>
        ))}
        {!readOnly && photos.length < MAX_PHOTOS && (
          <div className="parking-card-photo-wrap">
            <div className="parking-card-photo parking-card-photo-add">
              <input
                ref={cameraRef}
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                onChange={(e) => {
                  onAddPhoto(e.target.files)
                  e.target.value = ''
                }}
              />
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  onAddPhoto(e.target.files)
                  e.target.value = ''
                }}
              />
              <button
                type="button"
                className="parking-card-photo-add-btn"
                onClick={() => (isMobile ? cameraRef : fileRef).current?.click()}
                aria-label="写真を追加"
                title="写真を追加"
              >
                ＋
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="parking-card-fields">
        <div className="parking-card-row">
          <input
            type="text"
            placeholder="地域"
            list="parking-region-options"
            value={v.plate_region || ''}
            disabled={readOnly}
            onChange={(e) => onPatch({ plate_region: e.target.value })}
            aria-label="ナンバーの地域"
          />
          <input
            type="text"
            placeholder="ナンバー"
            inputMode="numeric"
            list="parking-plate-options"
            value={v.plate_number || ''}
            disabled={readOnly}
            onChange={(e) => onPatch({ plate_number: sanitizePlateNumber(e.target.value) })}
            aria-label="ナンバー"
          />
        </div>
        <div className="parking-card-row">
          <input
            type="text"
            placeholder="メーカー"
            list="parking-maker-options"
            value={v.maker || ''}
            disabled={readOnly}
            onChange={(e) => onPatch({ maker: e.target.value })}
            aria-label="メーカー"
          />
          <input
            type="text"
            placeholder="車種"
            list="parking-model-options"
            value={v.model || ''}
            disabled={readOnly}
            onChange={(e) => onPatch({ model: e.target.value })}
            aria-label="車種"
          />
        </div>
        <input
          type="text"
          placeholder="所有会社・訪問先（テナント名）"
          list="parking-owner-options"
          value={v.owner_company || ''}
          disabled={readOnly}
          onChange={(e) => onPatch({ owner_company: e.target.value })}
          aria-label="所有会社・訪問先"
        />
        <div className="parking-card-violations">
          {Object.entries(VIOLATION_LABELS).map(([key, label]) => (
            <label key={key} className="parking-violation-chip">
              <input
                type="checkbox"
                checked={v.violations.includes(key)}
                disabled={readOnly}
                onChange={() => onToggleType(key)}
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
          onChange={(e) => onPatch({ note: e.target.value })}
          aria-label="補足"
        />
      </div>
      {!readOnly && <ConfirmDeleteButton onConfirm={onDelete} label="この記録を削除" size={20} />}
    </li>
  )
}

// 写真の拡大表示。作業写真のプレビューと同じ構成（縮小後サイズ・撮影日時・削除・
// あわせてナンバー・車種の読み取りボタンをここに置く）
function ParkingPhotoPreview({ photo, violation, readOnly, onClose, onDelete, onRecognize }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [recognizing, setRecognizing] = useState(false)
  const [recognizeMessage, setRecognizeMessage] = useState('')

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

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleRecognizeClick() {
    setRecognizing(true)
    setRecognizeMessage('')
    try {
      const patch = await onRecognize()
      setRecognizeMessage(
        Object.keys(patch).length > 0
          ? '空欄だった項目に読み取り結果を反映しました。'
          : '読み取れませんでした。手動で入力してください。'
      )
    } catch (err) {
      setRecognizeMessage(err.message)
    } finally {
      setRecognizing(false)
    }
  }

  return (
    <div className="photo-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="photo-overlay-inner" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="photo-overlay-close" onClick={onClose} aria-label="閉じる">
          ×
        </button>
        {error ? (
          <p className="dashboard-error">{error}</p>
        ) : url ? (
          <img src={url} alt="違反車両の写真" />
        ) : (
          <p className="dashboard-loading">読み込み中…</p>
        )}
        {(photo.size > 0 || photo.taken_at) && (
          <p className="photo-overlay-caption">
            {[photo.size > 0 ? formatMB(photo.size) : null, photo.taken_at ? formatDateTime(photo.taken_at) : null]
              .filter(Boolean)
              .join('　')}
          </p>
        )}
        {(url || onDelete || onRecognize) && (
          <div className="photo-overlay-actions">
            {!readOnly && onRecognize && violation && (
              <button type="button" className="btn-plain" onClick={handleRecognizeClick} disabled={recognizing}>
                {recognizing ? '読み取り中…' : '写真から読み取る'}
              </button>
            )}
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
        {recognizeMessage && <p className="photo-overlay-caption">{recognizeMessage}</p>}
      </div>
    </div>
  )
}
