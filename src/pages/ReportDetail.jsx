import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReportPhotos from '../components/ReportPhotos'
import ReportParkingViolations from '../components/ReportParkingViolations'
import ConfirmDeleteButton from '../components/ConfirmDeleteButton'
import InspectionForm from '../components/InspectionForm'
import ChlorineForm from '../components/ChlorineForm'
import { IconClipboard, IconDroplet } from '../components/Icons'
import { getCurrentUser } from '../lib/auth'
import {
  fetchReport,
  createReport,
  updateReport,
  deleteReport,
  addEntry,
  updateEntry,
  deleteEntry,
  fetchTemplates,
  fetchPhotos,
  fetchParkingViolations,
  fetchInspections,
  fetchClosedDays,
  markClosedDay,
  deleteInspection,
  fetchChlorineTests,
  deleteChlorineTest,
  INSPECTION_BUILDINGS,
  todayJST,
  formatReportDate,
  toHHMM,
  sortEntriesByTime,
} from '../lib/reports'
import './Dashboard.css'

// 作業者の選択肢。設定の担当者名と揃えているが、日報側は「その他」も選べるようにする
const WORKERS = ['岡田', '西川', '橋口']

// 入力の取りこぼしを防ぐため、変更から少し待って自動保存する
const AUTOSAVE_MS = 800

// 日報の詳細。別画面ではなく**日報一覧の上に重ねるモーダル**として表示する（2026-08-07）。
// ホームボタンと前日/翌日の移動ボタンは廃止し、右上の「×」だけで閉じる。
// 呼び出しは ReportList.jsx（URL /reports/:date に :date があるときに描画する）。
// onClose: 閉じたあとの後始末（一覧へ戻る＋一覧の再読み込み）は呼び出し側が行う。
export default function ReportDetail({ date, onClose }) {
  const user = getCurrentUser()
  const isOwner = user?.role === 'owner'
  const readOnly = isOwner
  const building = INSPECTION_BUILDINGS[0]

  const [report, setReport] = useState(null)
  const [entries, setEntries] = useState([])
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [savedAt, setSavedAt] = useState(null)

  // 自主点検入力モーダル（この日の分を直接記録するショートカット。2026-08-07）。
  // ボタンの表示（未記載/記載済み）を最初から出し分けるため、開く前から状態を取得しておく
  const [inspectionOpen, setInspectionOpen] = useState(false)
  const [inspectionStatusLoading, setInspectionStatusLoading] = useState(true)
  const [dateInspection, setDateInspection] = useState(null)
  const [dateInspectionClosed, setDateInspectionClosed] = useState(false)
  // 自主点検モーダルが開いている間は、こちらのEscape処理を無効にする
  // （同じ window に付けた別リスナは stopPropagation では止まらないため、
  //   TaskDetail の previewOpenRef と同じ方式で親側を早期returnさせる）
  const inspectionOpenRef = useRef(false)

  // 残留塩素等検査入力モーダル（この日の分を直接記録するショートカット。2026-08-10）。
  // 自主点検と同じ考え方だが、chlorine_tests は建物ごとに複数レコードを持てるため、
  // ここでは「この日の最新の1件」の有無だけを見て登録/修正ボタンの表示を切り替える
  // （複数施設を同日に記録する場合、2件目以降の編集は残留塩素等検査画面から行う）
  const [chlorineOpen, setChlorineOpen] = useState(false)
  const [chlorineStatusLoading, setChlorineStatusLoading] = useState(true)
  const [dateChlorine, setDateChlorine] = useState(null)
  const chlorineOpenRef = useRef(false)

  // 明細の自動保存タイマー（明細IDごと）
  const timers = useRef(new Map())

  // Escapeで閉じる。handleClose は毎レンダー作り直されるため、常に最新を参照できるよう
  // refに載せ替えてからリスナに渡す（リスナ自体は登録/解除を繰り返さない）
  const closeRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const r = await fetchReport(date)
      setReport(r)
      setEntries(r?.entries || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [date])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    fetchTemplates()
      .then(setTemplates)
      .catch(() => setTemplates([])) // 定型文が取れなくても入力自体はできるようにする
  }, [])

  // 画面を離れる時に保留中の保存を流し切る
  useEffect(() => {
    const map = timers.current
    return () => {
      for (const t of map.values()) clearTimeout(t)
      map.clear()
    }
  }, [])

  useEffect(() => {
    function onKey(e) {
      if (e.key !== 'Escape') return
      if (inspectionOpenRef.current) return // 自主点検モーダル側に任せる
      if (chlorineOpenRef.current) return // 残留塩素モーダル側に任せる
      closeRef.current?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function markSaved() {
    setSavedAt(new Date())
  }

  // 表示は常に時刻順にする（一覧側とも共通の並び順。src/lib/reports.js）
  const sortedEntries = useMemo(() => sortEntriesByTime(entries), [entries])

  async function handleCreate() {
    setError('')
    try {
      const r = await createReport(date)
      setReport(r)
      setEntries(r.entries || [])
    } catch (err) {
      setError(err.message)
    }
  }

  // モーダルを閉じる。未入力（明細・写真・違反車両のいずれも無い）まま閉じる場合は、
  // 一覧の行タップで自動作成された空の日報を残さないよう削除する（2026-08-07）
  async function handleClose() {
    if (report && !readOnly && entries.length === 0) {
      try {
        const [photos, violations] = await Promise.all([
          fetchPhotos(report.id),
          fetchParkingViolations({ reportId: report.id }),
        ])
        if (photos.length === 0 && violations.length === 0) {
          await deleteReport(report.id)
        }
      } catch {
        // ロールバック判定に失敗しても閉じる操作自体は妨げない
      }
    }
    onClose()
  }

  async function handleDeleteReport() {
    if (!report || readOnly) return
    setError('')
    try {
      await deleteReport(report.id)
      onClose() // 既に削除済みなので handleClose のロールバック判定は通さない
    } catch (err) {
      setError(err.message)
    }
  }

  // 「休館日」指定。この日の日報を削除し、休館日として登録してから閉じる
  // （休館日は日報を持たない日という扱いのため。/api/report/closed-days 参照）
  async function handleMarkDayClosed() {
    if (!report || readOnly) return
    setError('')
    try {
      await deleteReport(report.id)
      await markClosedDay(date)
      onClose()
    } catch (err) {
      setError(err.message)
      load()
    }
  }

  const loadInspectionStatus = useCallback(async () => {
    setInspectionStatusLoading(true)
    try {
      const [list, closed] = await Promise.all([
        fetchInspections({ date }),
        fetchClosedDays({ month: date.slice(0, 7) }),
      ])
      setDateInspection(list[0] || null)
      setDateInspectionClosed(closed.includes(date))
    } catch (err) {
      setError(err.message)
    } finally {
      setInspectionStatusLoading(false)
    }
  }, [date])

  useEffect(() => {
    loadInspectionStatus()
  }, [loadInspectionStatus])

  function openInspection() {
    inspectionOpenRef.current = true
    setInspectionOpen(true)
  }

  function closeInspection() {
    inspectionOpenRef.current = false
    setInspectionOpen(false)
  }

  function handleInspectionSaved() {
    closeInspection()
    loadInspectionStatus() // ボタンの「未記載/記載済み」表示を保存結果に合わせて更新する
  }

  async function handleInspectionDelete(id) {
    try {
      await deleteInspection(id)
    } catch (err) {
      setError(err.message)
    }
    closeInspection()
    loadInspectionStatus()
  }

  // 残留塩素の記録有無。report が無い（この日の日報がまだ無い）場合は、そもそも
  // 記録も存在し得ない（記録があれば必ず日報が自動作成されているため）ので取得しない
  const loadChlorineStatus = useCallback(async () => {
    if (!report) {
      setDateChlorine(null)
      setChlorineStatusLoading(false)
      return
    }
    setChlorineStatusLoading(true)
    try {
      const list = await fetchChlorineTests({ reportId: report.id })
      setDateChlorine(list[0] || null)
    } catch (err) {
      setError(err.message)
    } finally {
      setChlorineStatusLoading(false)
    }
  }, [report])

  useEffect(() => {
    loadChlorineStatus()
  }, [loadChlorineStatus])

  function openChlorine() {
    chlorineOpenRef.current = true
    setChlorineOpen(true)
  }

  function closeChlorine() {
    chlorineOpenRef.current = false
    setChlorineOpen(false)
  }

  // 保存結果をそのままボタンの状態に反映する（一覧と違い、この画面では常に「この日の
  // 最新1件」しか扱わないため）。まだ日報が無かった場合はサーバー側で自動作成されている
  // ため、画面にもその日報を反映させる（作業者・時間欄が空のまま出てくるようにする）
  function handleChlorineSaved(saved) {
    closeChlorine()
    setDateChlorine(saved)
    if (!report) load()
  }

  async function handleChlorineDelete(id) {
    try {
      await deleteChlorineTest(id)
    } catch (err) {
      setError(err.message)
    }
    closeChlorine()
    setDateChlorine(null)
  }

  async function patchHeader(patch) {
    if (!report || readOnly) return
    setReport((prev) => ({ ...prev, ...patch }))
    try {
      await updateReport(report.id, patch)
      markSaved()
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleAddEntry(content = '') {
    if (!report || readOnly) return
    setError('')
    try {
      // 時刻は空欄で追加する（2026-08-04）。後からまとめて入力する運用が中心で、
      // 記録した時刻（現在時刻）を既定値にすると実際の作業時刻と食い違うため。
      const entry = await addEntry(report.id, { content })
      setEntries((prev) => [...prev, entry])
      markSaved()
    } catch (err) {
      setError(err.message)
    }
  }

  // 入力中は画面の値だけ更新し、少し待ってからまとめて保存する
  function handleEntryChange(id, patch) {
    if (readOnly) return
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)))
    const timer = timers.current.get(id)
    if (timer) clearTimeout(timer)
    timers.current.set(
      id,
      setTimeout(async () => {
        timers.current.delete(id)
        try {
          await updateEntry(id, patch)
          markSaved()
        } catch (err) {
          setError(err.message)
        }
      }, AUTOSAVE_MS)
    )
  }

  async function handleDeleteEntry(id) {
    if (readOnly) return
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
    setEntries((prev) => prev.filter((e) => e.id !== id))
    try {
      await deleteEntry(id)
      markSaved()
    } catch (err) {
      setError(err.message)
      load() // 失敗したら画面を実データに戻す
    }
  }

  const isToday = date === todayJST()
  // 上のkeydownリスナが常に最新の handleClose（report/entriesの最新値を閉じ込んだもの）を
  // 呼べるようにする。レンダー後に毎回書き換える
  closeRef.current = handleClose

  return (
    <>
      <div className="report-detail-overlay" role="dialog" aria-modal="true" onClick={handleClose}>
        <div className="report-detail-modal" onClick={(e) => e.stopPropagation()}>
          <div className="report-detail-head">
            <h2 className="page-title">
              {formatReportDate(date)}
              {isToday && <span className="report-today-badge">本日</span>}
            </h2>
            <div className="report-head-right">
              {savedAt && <span className="report-saved">保存しました</span>}
              {!readOnly && (
                // 未記載（この日の記録がまだ無い）のときは青地・白字で目立たせて登録を促し、
                // 記載済みのときは控えめな見た目のまま「修正」に変える（2026-08-07）
                <button
                  type="button"
                  className={dateInspection ? 'btn-plain' : 'btn-primary'}
                  onClick={openInspection}
                  disabled={inspectionStatusLoading}
                >
                  <IconClipboard size={18} />
                  {inspectionStatusLoading ? '読み込み中…' : dateInspection ? '自主点検修正' : '自主点検登録'}
                </button>
              )}
              {!readOnly && (
                // 自主点検ボタンと同じ考え方（未記載=青地で登録を促す／記載済み=控えめに修正）
                <button
                  type="button"
                  className={dateChlorine ? 'btn-plain' : 'btn-primary'}
                  onClick={openChlorine}
                  disabled={chlorineStatusLoading}
                >
                  <IconDroplet size={18} />
                  {chlorineStatusLoading ? '読み込み中…' : dateChlorine ? '残留塩素修正' : '残留塩素登録'}
                </button>
              )}
              {!readOnly && report && (
                <span className="report-head-delete">
                  <ConfirmDeleteButton onConfirm={handleDeleteReport} label="この日の日報を削除" size={22} />
                </span>
              )}
              {/* ホーム・前日/翌日のボタンは廃止し、この「×」だけで閉じる（2026-08-07） */}
              <button type="button" className="icon-btn-close" onClick={handleClose} aria-label="閉じる">
                ×
              </button>
            </div>
          </div>

          <div className="report-detail-body">
        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : !report ? (
          <div className="report-empty-card">
            <p>この日の日報はまだありません。</p>
            {!readOnly && (
              <button type="button" className="btn-primary" onClick={handleCreate}>
                ＋ この日の日報をつくる
              </button>
            )}
          </div>
        ) : (
          <>
            <section className="report-card">
              <h3 className="report-card-title">
                作業者・時間
                {!readOnly && <CloseDayButton onConfirm={handleMarkDayClosed} />}
              </h3>
              <div className="report-fields">
                <label className="report-field">
                  <span>作業者（午前）</span>
                  <WorkerSelect
                    value={report.worker_am}
                    disabled={readOnly}
                    onChange={(v) => patchHeader({ worker_am: v })}
                  />
                </label>
                <label className="report-field">
                  <span>作業者（午後）</span>
                  <WorkerSelect
                    value={report.worker_pm}
                    disabled={readOnly}
                    onChange={(v) => patchHeader({ worker_pm: v })}
                  />
                </label>
                <label className="report-field">
                  <span>開始</span>
                  <input
                    type="time"
                    value={toHHMM(report.work_start)}
                    disabled={readOnly}
                    onChange={(e) => patchHeader({ work_start: e.target.value })}
                  />
                </label>
                <label className="report-field">
                  <span>終了</span>
                  <input
                    type="time"
                    value={toHHMM(report.work_end)}
                    disabled={readOnly}
                    onChange={(e) => patchHeader({ work_end: e.target.value })}
                  />
                </label>
              </div>
            </section>

            <section className="report-card">
              <h3 className="report-card-title">
                作業記録
                <span className="report-count">{entries.length} 件</span>
              </h3>

              {entries.length === 0 && <p className="settings-hint">まだ記録がありません。</p>}

              <ul className="entry-list">
                {sortedEntries.map((e) => (
                  <li className="entry-row" key={e.id}>
                    <input
                      className="entry-time"
                      type="time"
                      value={toHHMM(e.entry_time)}
                      disabled={readOnly}
                      onChange={(ev) => handleEntryChange(e.id, { entry_time: ev.target.value })}
                      aria-label="時刻"
                    />
                    <textarea
                      className="entry-content"
                      value={e.content}
                      disabled={readOnly}
                      rows={2}
                      placeholder="作業内容"
                      onChange={(ev) => handleEntryChange(e.id, { content: ev.target.value })}
                      aria-label="作業内容"
                    />
                    {e.source_task_id && (
                      <span className="entry-from-task" title="タスク管理から転記">
                        タスク
                      </span>
                    )}
                    {!readOnly && (
                      <ConfirmDeleteButton onConfirm={() => handleDeleteEntry(e.id)} label="この記録を削除" size={22} />
                    )}
                  </li>
                ))}
              </ul>

              {!readOnly && (
                <div className="entry-add-row">
                  <button
                    type="button"
                    className="icon-btn-add is-compact entry-add-trigger"
                    onClick={() => handleAddEntry()}
                    aria-label="記録を追加"
                    title="記録を追加"
                  >
                    ＋
                  </button>
                  {templates.length > 0 && (
                    <select
                      className="entry-template-select"
                      value=""
                      aria-label="定型文から追加"
                      onChange={(e) => {
                        const label = e.target.value
                        e.target.value = ''
                        if (label) handleAddEntry(label)
                      }}
                    >
                      <option value="">定型文から追加…</option>
                      {templates.map((t) => (
                        <option key={t.id} value={t.label}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}
            </section>

            <ReportPhotos reportId={report.id} readOnly={readOnly} />

            <ReportParkingViolations reportId={report.id} readOnly={readOnly} />
          </>
        )}
          </div>
        </div>
      </div>

      {/* 自主点検モーダルは詳細モーダルのオーバーレイの外に出す。中に入れると、
          自主点検側の背景クリックが詳細側のオーバーレイにも伝播して両方閉じてしまう */}
      {inspectionOpen && (
        <InspectionForm
          date={date}
          building={building}
          existing={dateInspection}
          initialClosed={dateInspectionClosed}
          defaultInspector={user?.display_name || ''}
          onClose={closeInspection}
          onSaved={handleInspectionSaved}
          onDelete={handleInspectionDelete}
        />
      )}

      {/* 残留塩素モーダルも同じ理由で外に出す */}
      {chlorineOpen && (
        <ChlorineForm
          existing={dateChlorine}
          defaultDate={date}
          defaultInspector={user?.display_name || ''}
          onClose={closeChlorine}
          onSaved={handleChlorineSaved}
          onDelete={handleChlorineDelete}
        />
      )}
    </>
  )
}

// 担当者3名＋「その他」。その他を選ぶと自由入力に切り替わる
function WorkerSelect({ value, disabled, onChange }) {
  const isPreset = !value || WORKERS.includes(value)
  const [freeform, setFreeform] = useState(!isPreset)

  if (freeform) {
    return (
      <input
        type="text"
        value={value || ''}
        disabled={disabled}
        placeholder="担当者名"
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => {
          // 空にして離れたら選択に戻す
          if (!e.target.value.trim()) setFreeform(false)
        }}
      />
    )
  }
  return (
    <select
      value={value || ''}
      disabled={disabled}
      onChange={(e) => {
        if (e.target.value === '__other__') {
          // 自由入力へ切り替える。値は入力されてから保存されるのでここでは空のまま
          setFreeform(true)
          return
        }
        onChange(e.target.value)
      }}
    >
      <option value="">（未設定）</option>
      {WORKERS.map((w) => (
        <option key={w} value={w}>
          {w}
        </option>
      ))}
      <option value="__other__">その他…</option>
    </select>
  )
}

// 「休館日」指定ボタン。押しただけでは実行せず、削除して休館日にする旨の確認を挟む
// （ConfirmDeleteButtonと同じ2段階確認のパターンだが、削除ではなく「休館日への変換」
// という別の意味の操作のためテキストボタンにしている。2026-08-07）
function CloseDayButton({ onConfirm }) {
  const [confirming, setConfirming] = useState(false)

  if (confirming) {
    return (
      <span className="confirm-delete-group report-card-title-action" role="group" aria-label="休館日にする確認">
        <span className="confirm-delete-message">記録を削除して休館日にしますか？</span>
        <button
          type="button"
          className="confirm-delete-go"
          onClick={() => {
            setConfirming(false)
            onConfirm()
          }}
        >
          休館日にする
        </button>
        <button type="button" className="confirm-delete-cancel" onClick={() => setConfirming(false)}>
          キャンセル
        </button>
      </span>
    )
  }

  return (
    <button type="button" className="btn-plain report-card-title-action" onClick={() => setConfirming(true)}>
      休館日
    </button>
  )
}
