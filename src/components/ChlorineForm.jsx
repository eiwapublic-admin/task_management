import { useEffect, useState } from 'react'
import ConfirmDeleteButton from './ConfirmDeleteButton'
import ChlorinePhotos from './ChlorinePhotos'
import {
  CHLORINE_BUILDINGS,
  CHLORINE_JUDGEMENT_ITEMS,
  CHLORINE_STANDARD_MIN,
  createChlorineTest,
  updateChlorineTest,
  uploadPhoto,
  toDateTimeLocal,
} from '../lib/reports'

// 残留塩素等検査の入力モーダル（2026-08-10）。現行アプリ（FileMaker）の入力画面に合わせ、
// 上から 測定施設 → 測定場所・検査者 → 測定写真 → 測定日時 → 残留塩素濃度 →
// 色/濁り/臭気/味のOK・NG → 備考 の順に並べる。
//
// 新規登録では、保存を押して初めて検査レコードを作る（写真も同時にアップロードする）。
// 途中でキャンセルしてもレコード・写真・日報のどれも作られない。
export default function ChlorineForm({ existing, defaultBuilding, defaultInspector, onClose, onSaved, onDelete }) {
  const [building, setBuilding] = useState(existing?.building || defaultBuilding || CHLORINE_BUILDINGS[0])
  const [location, setLocation] = useState(existing?.location || '')
  const [inspector, setInspector] = useState(existing?.inspector || defaultInspector || '')
  const [testedAt, setTestedAt] = useState(toDateTimeLocal(existing?.tested_at))
  const [concentration, setConcentration] = useState(
    existing?.concentration === null || existing?.concentration === undefined ? '' : String(existing.concentration),
  )
  const [judgements, setJudgements] = useState(() => ({
    color_ok: existing?.color_ok ?? null,
    turbidity_ok: existing?.turbidity_ok ?? null,
    odor_ok: existing?.odor_ok ?? null,
    taste_ok: existing?.taste_ok ?? null,
  }))
  const [note, setNote] = useState(existing?.note || '')
  // 新規登録中に選んだ写真（保存時にまとめてアップロードする）
  const [pendingPhotos, setPendingPhotos] = useState([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 水道水質基準（遊離残留塩素 0.1mg/L 以上）を下回っていたら入力中に気付けるようにする
  const numericConcentration = concentration === '' ? null : Number(concentration)
  const belowStandard =
    numericConcentration !== null && Number.isFinite(numericConcentration) && numericConcentration < CHLORINE_STANDARD_MIN

  async function handleSave() {
    setSaving(true)
    setError('')
    try {
      const payload = {
        building,
        location,
        inspector,
        tested_at: testedAt ? new Date(testedAt).toISOString() : new Date().toISOString(),
        concentration: concentration === '' ? null : Number(concentration),
        note,
        ...judgements,
      }
      const saved = existing ? await updateChlorineTest(existing.id, payload) : await createChlorineTest(payload)

      // 新規登録時に選んでおいた写真は、レコードができてからアップロードする。
      // 1枚でも失敗したら理由を出す（記録自体は保存済みなので閉じずに再試行できる）
      for (const p of pendingPhotos) {
        await uploadPhoto({
          reportId: saved.report_id,
          category: 'chlorine',
          chlorineId: saved.id,
          file: p.file,
          filename: p.filename,
          width: p.width,
          height: p.height,
          takenAt: p.takenAt,
        })
      }
      onSaved(saved)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  function setJudgement(key, value) {
    setJudgements((prev) => ({ ...prev, [key]: prev[key] === value ? null : value }))
  }

  return (
    <div className="inspection-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="inspection-modal" onClick={(e) => e.stopPropagation()}>
        <div className="inspection-modal-head">
          <h3>残留塩素等検査{existing ? '' : '（新規）'}</h3>
          <button type="button" className="icon-btn-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>

        <div className="inspection-modal-body">
          {error && (
            <p className="dashboard-error dashboard-banner" role="alert">
              {error}
            </p>
          )}

          <label className="report-field chlorine-building-field">
            <span>測定施設</span>
            <select value={building} onChange={(e) => setBuilding(e.target.value)}>
              {CHLORINE_BUILDINGS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>

          <div className="report-fields">
            <label className="report-field">
              <span>測定場所</span>
              <input
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="1F給湯室"
              />
            </label>
            <label className="report-field">
              <span>検査者</span>
              <input
                type="text"
                value={inspector}
                onChange={(e) => setInspector(e.target.value)}
                placeholder="検査者名"
              />
            </label>
          </div>

          <ChlorinePhotos
            chlorineId={existing?.id || null}
            reportId={existing?.report_id || null}
            pending={pendingPhotos}
            onPendingChange={setPendingPhotos}
          />

          <div className="report-fields">
            <label className="report-field">
              <span>測定日時</span>
              <input
                type="datetime-local"
                value={testedAt}
                onChange={(e) => setTestedAt(e.target.value)}
                className="chlorine-datetime"
              />
            </label>
            <label className="report-field">
              <span>残留塩素濃度（mg/L）</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                max="99.99"
                value={concentration}
                onChange={(e) => setConcentration(e.target.value)}
                placeholder="0.10"
              />
            </label>
          </div>

          {belowStandard && (
            <p className="chlorine-warning" role="status">
              水道水質基準（遊離残留塩素 {CHLORINE_STANDARD_MIN.toFixed(1)}mg/L 以上）を下回っています。
            </p>
          )}

          <div className="chlorine-judgements">
            {CHLORINE_JUDGEMENT_ITEMS.map((item) => (
              <div className="chlorine-judgement-row" key={item.key}>
                <span className="chlorine-judgement-label">{item.label}</span>
                <div className="chlorine-judgement-buttons" role="group" aria-label={item.label}>
                  <button
                    type="button"
                    className={`chlorine-judgement-btn is-ok${judgements[item.key] === true ? ' is-active' : ''}`}
                    aria-pressed={judgements[item.key] === true}
                    onClick={() => setJudgement(item.key, true)}
                  >
                    OK
                  </button>
                  <button
                    type="button"
                    className={`chlorine-judgement-btn is-ng${judgements[item.key] === false ? ' is-active' : ''}`}
                    aria-pressed={judgements[item.key] === false}
                    onClick={() => setJudgement(item.key, false)}
                  >
                    NG
                  </button>
                </div>
              </div>
            ))}
          </div>

          <label className="report-field chlorine-note-field">
            <span>備考</span>
            <textarea value={note} rows={3} onChange={(e) => setNote(e.target.value)} placeholder="備考" />
          </label>
        </div>

        <div className="inspection-modal-foot">
          <div className="inspection-modal-foot-left">
            {existing && (
              <ConfirmDeleteButton onConfirm={() => onDelete(existing.id)} label="この記録を削除" size={22} />
            )}
          </div>
          <div className="inspection-modal-foot-right">
            <button type="button" className="btn-plain" onClick={onClose}>
              キャンセル
            </button>
            <button type="button" className="btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? '保存中…' : '記録する'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
