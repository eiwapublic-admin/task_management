import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  updateParkingViolation,
  fetchParkingViolations,
  fetchPhotos,
  uploadPhoto,
  deletePhoto,
  fetchPhotoObjectUrl,
  recognizeParkingPhoto,
  sanitizePlateNumber,
  VIOLATION_LABELS,
  formatReportDate,
} from '../lib/reports'
import { ParkingPhotoPreview } from './ReportParkingViolations'
import { prepareImage, formatMB } from '../lib/imageResize'
import { formatDateTime } from '../lib/format'
import ConfirmDeleteButton from './ConfirmDeleteButton'
import Combobox from './Combobox'
import useBodyScrollLock from '../lib/useBodyScrollLock'

function uniqueSorted(list) {
  return [...new Set(list.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'))
}

// モバイル判定の分岐点。ReportParkingViolations.jsx と揃える
const MOBILE_QUERY = '(max-width: 640px)'
// 1件につき写真は2枚まで（ReportParkingViolations.jsx と同じ上限）
const MAX_PHOTOS = 2

// 違反車両一覧（/reports/parking）の明細クリックで開く詳細モーダル（2026-08-11）。
// 日報詳細の登録フォーム（ReportParkingViolations/ParkingCard）と同じ項目・写真読み取りを、
// 単票の閲覧・編集用にまとめたもの。フィールドは自動保存せず、ChlorineForm と同じ
// 「保存」ボタンで確定する方式にしている（複数写真＋複数項目を一括で扱うため）。
export default function ParkingViolationDetail({ violation, readOnly, onClose, onSaved, onDelete }) {
  // 開いている間は裏の一覧を固定する（共通フック）
  useBodyScrollLock()

  const [plateRegion, setPlateRegion] = useState(violation.plate_region || '')
  const [plateNumber, setPlateNumber] = useState(violation.plate_number || '')
  const [maker, setMaker] = useState(violation.maker || '')
  const [model, setModel] = useState(violation.model || '')
  const [ownerCompany, setOwnerCompany] = useState(violation.owner_company || '')
  const [violationTypes, setViolationTypes] = useState(violation.violations || [])
  const [note, setNote] = useState(violation.note || '')

  const [photos, setPhotos] = useState([])
  const [urls, setUrls] = useState({})
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(null)
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches)
  // 地域・メーカー・車種・所有会社をリスト選択できるよう、全期間の履歴を一度だけ取得する
  // （ReportParkingViolations.jsx と同じ方式。2026-08-19）
  const [historical, setHistorical] = useState([])
  const cameraRef = useRef(null)
  const fileRef = useRef(null)
  const createdUrls = useRef(new Set())

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY)
    const onChange = () => setIsMobile(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    fetchParkingViolations()
      .then(setHistorical)
      .catch(() => setHistorical([]))
  }, [])

  const options = useMemo(
    () => ({
      region: uniqueSorted(historical.map((v) => v.plate_region)),
      maker: uniqueSorted(historical.map((v) => v.maker)),
      model: uniqueSorted(historical.map((v) => v.model)),
      owner: uniqueSorted(historical.map((v) => v.owner_company)),
    }),
    [historical]
  )

  // 違反車両の写真は日報単位で保存されているため、当該日報の parking カテゴリ全体を
  // 取得してこのレコードの分だけ絞り込む（ReportParkingViolations.jsx と同じ方式）
  const load = useCallback(async () => {
    try {
      const list = await fetchPhotos(violation.report_id, 'parking')
      setPhotos(list.filter((p) => p.parking_id === violation.id))
    } catch (err) {
      setError(err.message)
    }
  }, [violation.report_id, violation.id])

  useEffect(() => {
    load()
  }, [load])

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
        .catch(() => {})
    }
    return () => {
      cancelled = true
    }
  }, [photos, urls])

  useEffect(() => {
    const set = createdUrls.current
    return () => {
      for (const url of set) URL.revokeObjectURL(url)
      set.clear()
    }
  }, [])

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleAddPhoto(fileList) {
    const files = Array.from(fileList || [])
    if (files.length === 0) return
    setError('')
    setUploading(true)
    try {
      const file = files[0]
      const prepared = await prepareImage(file, 'parking')
      const photo = await uploadPhoto({
        reportId: violation.report_id,
        category: 'parking',
        parkingId: violation.id,
        file: prepared.file,
        thumb: prepared.thumb,
        filename: file.name,
        width: prepared.width,
        height: prepared.height,
        takenAt: file.lastModified ? new Date(file.lastModified).toISOString() : null,
      })
      setPhotos((prev) => [...prev, photo])
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  async function handleDeletePhoto(photoId) {
    setPhotos((prev) => prev.filter((p) => p.id !== photoId))
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
  async function handleRecognize(photoId) {
    const result = await recognizeParkingPhoto(photoId)
    if (!plateRegion && result.plate_region) setPlateRegion(result.plate_region)
    if (!plateNumber && result.plate_number) setPlateNumber(sanitizePlateNumber(result.plate_number))
    if (!maker && result.maker) setMaker(result.maker)
    if (!model && result.model) setModel(result.model)
    return result
  }

  function toggleType(type) {
    if (readOnly) return
    setViolationTypes((prev) => (prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]))
  }

  async function handleSave() {
    // 所有会社・訪問先は必須。不明な場合は「（不明）」と入力する運用のため、
    // 空欄のままでは保存させない（2026-08-19）
    if (!ownerCompany.trim()) {
      setError('所有会社・訪問先を入力してください（不明な場合は「（不明）」と入力）')
      return
    }
    setSaving(true)
    setError('')
    try {
      const updated = await updateParkingViolation(violation.id, {
        plate_region: plateRegion,
        plate_number: plateNumber,
        maker,
        model,
        owner_company: ownerCompany,
        violations: violationTypes,
        note,
      })
      onSaved(updated)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <>
      {/* 写真の拡大表示（ParkingPhotoPreview）はこのモーダルの外側の兄弟として描画する。
          内側に置くと、拡大表示の背景クリック（閉じる操作）がこのオーバーレイの onClose まで
          伝播し、写真だけ閉じたいのに詳細モーダルごと閉じてしまう */}
      <div className="ui-overlay is-nested" role="dialog" aria-modal="true" onClick={onClose}>
        <div className="ui-modal is-sm" onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h3 className="ui-modal-title">違反車両（{formatReportDate(violation.report_date)}）</h3>
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

          <div className="parking-card-photos">
            {photos.map((photo) => (
              <div className="parking-card-photo-wrap" key={photo.id}>
                <button
                  type="button"
                  className="parking-card-photo"
                  onClick={() => setPreview(photo)}
                  aria-label="写真を拡大"
                >
                  {urls[photo.id] ? (
                    <img src={urls[photo.id]} alt="違反車両の写真" />
                  ) : (
                    <span className="photo-loading">読み込み中…</span>
                  )}
                </button>
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
                    className="parking-card-photo-add-btn"
                    onClick={() => (isMobile ? cameraRef : fileRef).current?.click()}
                    disabled={uploading}
                    aria-label="写真を追加"
                    title="写真を追加"
                  >
                    {uploading ? '…' : '＋'}
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="report-fields is-halves">
            <div className="report-field">
              <span>地域</span>
              <Combobox
                value={plateRegion}
                onChange={setPlateRegion}
                options={options.region}
                placeholder="地域"
                disabled={readOnly}
              />
            </div>
            <label className="report-field">
              <span>ナンバー</span>
              <input
                type="text"
                inputMode="numeric"
                value={plateNumber}
                disabled={readOnly}
                onChange={(e) => setPlateNumber(sanitizePlateNumber(e.target.value))}
                placeholder="ナンバー"
              />
            </label>
          </div>

          <div className="report-fields is-halves">
            <div className="report-field">
              <span>メーカー</span>
              <Combobox
                value={maker}
                onChange={setMaker}
                options={options.maker}
                placeholder="メーカー"
                disabled={readOnly}
              />
            </div>
            <div className="report-field">
              <span>車種</span>
              <Combobox
                value={model}
                onChange={setModel}
                options={options.model}
                placeholder="車種"
                disabled={readOnly}
              />
            </div>
          </div>

          <div className="report-field">
            <span>所有会社・訪問先（テナント名）※必須。不明な場合は「（不明）」</span>
            <Combobox
              value={ownerCompany}
              onChange={setOwnerCompany}
              options={options.owner}
              placeholder="所有会社・訪問先"
              disabled={readOnly}
              className={ownerCompany ? '' : 'is-required-empty'}
            />
          </div>

          <div className="parking-card-violations">
            {Object.entries(VIOLATION_LABELS).map(([key, label]) => (
              <label key={key} className="parking-violation-chip">
                <input
                  type="checkbox"
                  checked={violationTypes.includes(key)}
                  disabled={readOnly}
                  onChange={() => toggleType(key)}
                />
                {label}
              </label>
            ))}
          </div>

          <label className="report-field chlorine-note-field">
            <span>補足</span>
            <textarea
              value={note}
              rows={3}
              disabled={readOnly}
              onChange={(e) => setNote(e.target.value)}
              placeholder="補足"
            />
          </label>
        </div>

        <div className="ui-modal-foot">
          <div className="ui-modal-foot-start">
            {!readOnly && (
              <ConfirmDeleteButton onConfirm={() => onDelete(violation.id)} label="この記録を削除" size={22} />
            )}
          </div>
          <div className="ui-modal-foot-end">
            <button type="button" className="btn-plain" onClick={onClose}>
              {readOnly ? '閉じる' : 'キャンセル'}
            </button>
            {!readOnly && (
              <button type="button" className="btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? '保存中…' : '保存する'}
              </button>
            )}
          </div>
        </div>
      </div>
      </div>

      {preview && (
        <ParkingPhotoPreview
          photo={preview}
          violation={{ id: violation.id, plate_region: plateRegion, plate_number: plateNumber, maker, model }}
          readOnly={readOnly}
          onClose={() => setPreview(null)}
          onDelete={
            readOnly
              ? undefined
              : async () => {
                  await handleDeletePhoto(preview.id)
                  setPreview(null)
                }
          }
          onRecognize={readOnly ? undefined : () => handleRecognize(preview.id)}
        />
      )}
    </>
  )
}
