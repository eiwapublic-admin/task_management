import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import MeterPhoto from '../components/MeterPhoto'
import { IconTrash } from '../components/Icons'
import { prepareImage } from '../lib/imageResize'
import {
  activeMeters,
  assignMeterPhoto,
  defaultMeterMonth,
  deleteMeterPhoto,
  fetchMeterMonth,
  latestPhotoByMeter,
  meterMonthLabel,
  uploadMeterPhoto,
} from '../lib/meter'
import { formatTaken } from '../lib/meterMonth'
import { readPhotoDate } from '../lib/photoDate'
import './Dashboard.css'
import './Meter.css'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

// 写真の取込（2026-10-20〜。docs/meter-plan.md 3-1・3-2）。
// iPhone の「カメラ」で撮った検針写真をまとめて選ぶと、1枚ずつ
//   ① 元の解像度のままバーコード（Code39 *メータ番号*）を読む → ② 360×480・画質55に縮小 → ③ 送信
// し、サーバーがバーコードのメータへ割り当てる。読めなかった写真は下の一覧から手で割り当てる。
// FileMaker の「過不足の確認」の代わりに、写真の無いメータと割り当てていない写真を常に出す
export default function MeterPhotos() {
  const params = useParams()
  const navigate = useNavigate()
  const month = MONTH_RE.test(params.month || '') ? params.month : defaultMeterMonth()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [queue, setQueue] = useState([]) // 取込中・取込済みの写真 { name, status, meterNo, message }
  const [running, setRunning] = useState(false)

  const load = useCallback(async () => {
    setError('')
    try {
      setData(await fetchMeterMonth(month))
    } catch (err) {
      setError(err.message)
    }
  }, [month])

  useEffect(() => {
    load()
  }, [load])

  const meters = useMemo(() => (data ? activeMeters(data.meters) : []), [data])
  const meterById = useMemo(() => new Map((data?.meters || []).map((m) => [m.id, m])), [data])
  const latest = useMemo(() => latestPhotoByMeter(data?.photos || []), [data])
  const missing = useMemo(
    () => meters.filter((m) => !latest[m.id]).sort((a, b) => a.meter_no.localeCompare(b.meter_no, 'ja', { numeric: true })),
    [meters, latest]
  )
  const unassigned = useMemo(() => (data?.photos || []).filter((p) => !p.meter_id), [data])
  const assigned = useMemo(
    () =>
      (data?.photos || [])
        .filter((p) => p.meter_id)
        .sort((a, b) =>
          (meterById.get(a.meter_id)?.meter_no || '').localeCompare(meterById.get(b.meter_id)?.meter_no || '', 'ja', {
            numeric: true,
          })
        ),
    [data, meterById]
  )
  const duplicateMeterIds = useMemo(() => {
    const count = new Map()
    for (const p of data?.photos || []) if (p.meter_id) count.set(p.meter_id, (count.get(p.meter_id) || 0) + 1)
    return new Set([...count].filter(([, n]) => n > 1).map(([id]) => id))
  }, [data])

  function addPhoto(photo) {
    setData((d) => ({ ...d, photos: [...d.photos, photo] }))
  }

  function replacePhoto(photo) {
    setData((d) => ({ ...d, photos: d.photos.map((p) => (p.id === photo.id ? photo : p)) }))
  }

  async function handleFiles(e) {
    const files = [...(e.target.files || [])]
    e.target.value = ''
    if (!files.length) return
    const startAt = queue.length
    setQueue((q) => [...q, ...files.map((f) => ({ name: f.name, status: 'waiting' }))])
    setRunning(true)
    // バーコードの読み取り（ZXing）は大きいので、この画面で写真を選んだときだけ読み込む
    const { readMeterBarcode } = await import('../lib/barcode')
    const update = (i, patch) => setQueue((q) => q.map((item, j) => (j === startAt + i ? { ...item, ...patch } : item)))
    for (const [i, file] of files.entries()) {
      update(i, { status: 'reading' })
      try {
        const [barcode, taken] = await Promise.all([readMeterBarcode(file), readPhotoDate(file)])
        update(i, { status: 'sending' })
        const prepared = await prepareImage(file, 'meter')
        const photo = await uploadMeterPhoto({
          month,
          file: prepared.file,
          filename: file.name,
          barcode,
          takenAt: taken?.iso,
          width: prepared.width,
          height: prepared.height,
        })
        addPhoto(photo)
        const meter = photo.meter_id ? meterById.get(photo.meter_id) : null
        update(i, {
          status: meter ? 'done' : 'unassigned',
          meterNo: meter?.meter_no,
          message: meter
            ? `メータ ${meter.meter_no}`
            : barcode
              ? `バーコード「${barcode}」のメータがマスタにありません`
              : 'バーコードを読めませんでした',
        })
      } catch (err) {
        update(i, { status: 'error', message: err.message })
      }
    }
    setRunning(false)
  }

  async function assign(photo, meterId) {
    setError('')
    try {
      replacePhoto(await assignMeterPhoto(photo.id, meterId))
    } catch (err) {
      setError(err.message)
    }
  }

  async function remove(photo) {
    const meter = photo.meter_id ? meterById.get(photo.meter_id) : null
    if (!window.confirm(`${meter ? `メータ ${meter.meter_no} の` : ''}この写真を削除します。よろしいですか？`)) return
    setError('')
    try {
      await deleteMeterPhoto(photo.id)
      setData((d) => ({ ...d, photos: d.photos.filter((p) => p.id !== photo.id) }))
    } catch (err) {
      setError(err.message)
    }
  }

  const doneCount = queue.filter((q) => q.status === 'done' || q.status === 'unassigned' || q.status === 'error').length

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-wide app-scroll">
        <FeatureHeader
          title={`${meterMonthLabel(month)}の写真`}
          leading={
            <button type="button" className="btn-plain" onClick={() => navigate(`/meter/${month}`)}>
              一覧へ
            </button>
          }
          actions={
            <label className={`btn-primary meter-file-btn${running ? ' is-disabled' : ''}`}>
              写真を選ぶ
              <input type="file" accept="image/*" multiple onChange={handleFiles} disabled={running || !data} hidden />
            </label>
          }
        />

        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}

        {!data && !error ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : !data ? null : (
          <div className="meter-stack">
            <p className="ui-note">
              iPhone の「写真」から、この月度に撮った検針写真をまとめて選んでください。バーコードを読んでメータへ自動で割り当てます。
              同じメータの写真が2枚以上あるときは、撮影日時の新しい方を使います。
            </p>

            {queue.length > 0 && (
              <section className="ui-card meter-queue">
                <h3 className="ui-card-title">
                  取込 {doneCount} / {queue.length}枚{running ? '（処理中…）' : ''}
                </h3>
                <ul className="meter-queue-list">
                  {queue.map((q, i) => (
                    <li key={i} className={`is-${q.status}`}>
                      <span className="meter-queue-name">{q.name}</span>
                      <span>
                        {q.status === 'waiting'
                          ? '待機中'
                          : q.status === 'reading'
                            ? 'バーコードを読んでいます'
                            : q.status === 'sending'
                              ? '送信しています'
                              : q.message}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="ui-card">
              <h3 className="ui-card-title">
                割り当てていない写真 {unassigned.length}枚
              </h3>
              {unassigned.length === 0 ? (
                <p className="ui-note">ありません。</p>
              ) : (
                <div className="meter-photo-grid">
                  {unassigned.map((p) => (
                    <figure key={p.id} className="meter-photo-card">
                      <MeterPhoto photo={p} />
                      <figcaption>
                        <span className="ui-note">
                          {formatTaken(p.taken_at)}
                          {p.barcode ? `・読めた番号「${p.barcode}」` : ''}
                        </span>
                        <select className="ui-select" value="" onChange={(e) => assign(p, e.target.value)}>
                          <option value="">メータを選ぶ…</option>
                          {missing.length > 0 && (
                            <optgroup label="写真の無いメータ">
                              {missing.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.meter_no} {m.seal_label || m.room_name || ''}
                                </option>
                              ))}
                            </optgroup>
                          )}
                          <optgroup label="すべてのメータ">
                            {meters.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.meter_no} {m.seal_label || m.room_name || ''}
                              </option>
                            ))}
                          </optgroup>
                        </select>
                        <button type="button" className="icon-btn-delete" onClick={() => remove(p)} aria-label="削除" title="削除">
                          <IconTrash size={18} />
                        </button>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              )}
            </section>

            <section className="ui-card">
              <h3 className="ui-card-title">
                写真の無いメータ {missing.length} / {meters.length}台
              </h3>
              {missing.length === 0 ? (
                <p className="meter-check-ok">すべてのメータに写真があります。</p>
              ) : (
                <ul className="meter-missing-list">
                  {missing.map((m) => (
                    <li key={m.id}>
                      <strong className="meter-no">{m.meter_no}</strong> {m.seal_label || m.room_name || ''}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="ui-card">
              <h3 className="ui-card-title">割り当て済みの写真 {assigned.length}枚</h3>
              {assigned.length === 0 ? (
                <p className="ui-note">まだありません。</p>
              ) : (
                <div className="meter-photo-grid">
                  {assigned.map((p) => {
                    const meter = meterById.get(p.meter_id)
                    const used = latest[p.meter_id]?.id === p.id
                    return (
                      <figure key={p.id} className={`meter-photo-card${used ? '' : ' is-unused'}`}>
                        <MeterPhoto photo={p} />
                        <figcaption>
                          <span>
                            <strong className="meter-no">{meter?.meter_no}</strong>{' '}
                            {duplicateMeterIds.has(p.meter_id) && (
                              <span className={`ui-badge${used ? ' is-current' : ''}`}>{used ? '使う写真' : '使わない（古い方）'}</span>
                            )}
                          </span>
                          <span className="ui-note">{formatTaken(p.taken_at)}</span>
                          <select className="ui-select" value={p.meter_id} onChange={(e) => assign(p, e.target.value)}>
                            {meters.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.meter_no} {m.seal_label || m.room_name || ''}
                              </option>
                            ))}
                            <option value="">（割り当てを外す）</option>
                          </select>
                          <button type="button" className="icon-btn-delete" onClick={() => remove(p)} aria-label="削除" title="削除">
                            <IconTrash size={18} />
                          </button>
                        </figcaption>
                      </figure>
                    )
                  })}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
