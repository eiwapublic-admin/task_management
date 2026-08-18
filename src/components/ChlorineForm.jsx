import { useEffect, useState } from 'react'
import ConfirmDeleteButton from './ConfirmDeleteButton'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import ChlorinePhotos from './ChlorinePhotos'
import {
  CHLORINE_BUILDINGS,
  CHLORINE_JUDGEMENT_ITEMS,
  CHLORINE_STANDARD_MIN,
  CHLORINE_CONCENTRATION_OPTIONS,
  createChlorineTest,
  updateChlorineTest,
  fetchChlorineTests,
  uploadPhoto,
  toDateTimeLocal,
} from '../lib/reports'

// 残留塩素等検査の入力モーダル（2026-08-10）。現行アプリ（FileMaker）の入力画面に合わせ、
// 上から 測定施設 → 測定場所・検査者 → 測定写真 → 測定日時 → 残留塩素濃度 →
// 色/濁り/臭気/味のOK・NG → 備考 の順に並べる。
//
// 新規登録では、保存を押して初めて検査レコードを作る（写真も同時にアップロードする）。
// 途中でキャンセルしてもレコード・写真・日報のどれも作られない。
//
// defaultDate: 日報詳細の「残留塩素」ボタン（2026-08-10〜）から開く場合、測定日時の既定値を
// 「今」ではなく表示中の日付にするために渡す（'YYYY-MM-DD'）。過去日の日報を開いて記録した
// つもりが、今日の日付で保存されてしまう（＝別の日の日報に付いてしまう）のを防ぐため
export default function ChlorineForm({
  existing,
  defaultBuilding,
  defaultInspector,
  defaultDate,
  noticeMessage,
  onClose,
  onSaved,
  onDelete,
}) {
  // 開いている間は裏の画面を固定する（共通フック。入れ子でも数えて管理する）
  useBodyScrollLock()

  const [building, setBuilding] = useState(existing?.building || defaultBuilding || CHLORINE_BUILDINGS[0])
  const [location, setLocation] = useState(existing?.location || '')
  // 新規登録時、測定場所は施設ごとの最後の入力値をデフォルト表示する（2026-08-10）。
  // ユーザーが一度でも手で書き換えたら、以後は施設を切り替えても上書きしない
  const [locationTouched, setLocationTouched] = useState(Boolean(existing))
  const [inspector, setInspector] = useState(existing?.inspector || defaultInspector || '')
  const [testedAt, setTestedAt] = useState(() => {
    if (existing) return toDateTimeLocal(existing.tested_at)
    if (defaultDate) {
      // 日付だけ確実に指定日にし、時刻は現在時刻を組み合わせる
      const now = new Date()
      const hh = String(now.getHours()).padStart(2, '0')
      const mm = String(now.getMinutes()).padStart(2, '0')
      return `${defaultDate}T${hh}:${mm}`
    }
    return toDateTimeLocal()
  })
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
  // 新規登録で検査レコード自体は作成できたが、そのあとの写真アップロードで失敗/タイムアウト
  // した場合に覚えておく（2026-08-13）。再試行時にこれが無いと、既にできているレコードとは
  // 別にもう1件 createChlorineTest してしまい重複登録になる（`existing` は再試行後も null の
  // ままのため）。以後の再試行はこれを使って updateChlorineTest に切り替える
  const [createdRecord, setCreatedRecord] = useState(null)

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 新規登録時のみ、施設を切り替えるたびその施設で最後に記録した測定場所を取得して
  // 既定値に反映する（2026-08-10）。既存レコードの編集時・ユーザーが手で書き換えた後は行わない
  useEffect(() => {
    if (existing || locationTouched) return
    let cancelled = false
    fetchChlorineTests({ building })
      .then((tests) => {
        if (cancelled) return
        const last = tests[0]?.location
        if (last) setLocation(last)
      })
      .catch(() => {}) // 取得できなくても入力自体は続けられるようにする
    return () => {
      cancelled = true
    }
  }, [building, existing, locationTouched])

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
      // レコード自体は既にできている（写真アップロードの再試行）場合は作り直さず更新にする
      const targetId = createdRecord?.id || existing?.id
      const saved = targetId ? await updateChlorineTest(targetId, payload) : await createChlorineTest(payload)
      if (!existing) setCreatedRecord(saved)

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
    } finally {
      // 成功時は「保存中」ボタンの意味自体が消える（呼び出し元がモーダルを閉じる/
      // 次の入力へ進める）ため従来は catch 側でしか戻していなかったが、それだと
      // 万一 onSaved 後もこのフォームが表示され続けるケースで「保存中…」のまま
      // 固まって見える（2026-08-13。写真アップロードのタイムアウト対策と合わせて
      // 必ず戻すようにした）
      setSaving(false)
    }
  }

  function setJudgement(key, value) {
    setJudgements((prev) => ({ ...prev, [key]: prev[key] === value ? null : value }))
  }

  return (
    <div className="ui-overlay is-nested" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="ui-modal is-sm" onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h3 className="ui-modal-title">残留塩素等検査{existing ? '' : '（新規）'}</h3>
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

          {/* BKB・小泉本社のペア記録の続き（2026-08-13。Chlorine.jsx の handleSaved 参照）。
              通常の新規登録・既存編集では渡されない */}
          {noticeMessage && (
            <p className="chlorine-pair-hint" role="status">
              {noticeMessage}
            </p>
          )}

          <div className="chlorine-building-field">
            <span className="chlorine-field-label">測定施設</span>
            <div className="chlorine-building-toggle" role="group" aria-label="測定施設">
              {CHLORINE_BUILDINGS.map((b) => (
                <button
                  key={b}
                  type="button"
                  className={`chlorine-building-btn${building === b ? ' is-active' : ''}`}
                  aria-pressed={building === b}
                  onClick={() => setBuilding(b)}
                >
                  {b}
                </button>
              ))}
            </div>
          </div>

          <div className="report-fields chlorine-loc-inspector-row">
            <label className="report-field">
              <span className="chlorine-field-label">測定場所</span>
              <input
                type="text"
                value={location}
                onChange={(e) => {
                  setLocationTouched(true)
                  setLocation(e.target.value)
                }}
                placeholder="測定場所"
              />
            </label>
            <label className="report-field">
              <span className="chlorine-field-label">検査者</span>
              <input
                type="text"
                value={inspector}
                onChange={(e) => setInspector(e.target.value)}
                placeholder="検査者"
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
              {/* リスト選択のみ（2026-08-18。自由入力欄は廃止。入力ミスを防ぐため） */}
              <select value={concentration} onChange={(e) => setConcentration(e.target.value)}>
                <option value="">選択…</option>
                {CHLORINE_CONCENTRATION_OPTIONS.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {belowStandard && (
            <p className="chlorine-warning" role="status">
              水道水質基準（遊離残留塩素 {CHLORINE_STANDARD_MIN.toFixed(1)}mg/L 以上）を下回っています。
            </p>
          )}

          {/* PC幅では備考欄を色・濁り・臭気・味の右側の余白に並べる（2026-08-11）。
              モバイル幅は従来どおり縦に積む（.chlorine-judgements-row のメディアクエリ参照） */}
          <div className="chlorine-judgements-row">
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
        </div>

        <div className="ui-modal-foot">
          <div className="ui-modal-foot-start">
            {existing && (
              <ConfirmDeleteButton onConfirm={() => onDelete(existing.id)} label="この記録を削除" size={22} />
            )}
          </div>
          <div className="ui-modal-foot-end">
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
