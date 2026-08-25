import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReportPhotos from '../components/ReportPhotos'
import ReportParkingViolations from '../components/ReportParkingViolations'
import ConfirmDeleteButton from '../components/ConfirmDeleteButton'
import InspectionForm from '../components/InspectionForm'
import TimeInput from '../components/TimeInput'
import { IconCheckCircle } from '../components/Icons'
import { getCurrentUser, isLimitedRole } from '../lib/auth'
import useBodyScrollLock from '../lib/useBodyScrollLock'
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
  deleteInspection,
  markClosedDay,
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
// BKBのみ運用のため固定にする（Inspections.jsx/ReportList.jsxと同じ）
const INSPECTION_BUILDING = INSPECTION_BUILDINGS[0]

export default function ReportDetail({ date, onClose }) {
  const user = getCurrentUser()
  // 日報の書き込みは owner・備品出庫限定ロール（2026-08-25追加）どちらも不可
  const isOwner = isLimitedRole(user)
  const readOnly = isOwner
  const [report, setReport] = useState(null)
  const [entries, setEntries] = useState([])
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [savedAt, setSavedAt] = useState(null)
  // ヘッダの「自主点検」ボタン用（2026-08-18）。この日の既存記録・休館日状態を
  // 先読みしておき、入力ウインドウを開くときに渡す
  const [inspectionStatus, setInspectionStatus] = useState({ existing: null, closed: false })
  const [loadingInspectionStatus, setLoadingInspectionStatus] = useState(true)
  const [editingInspection, setEditingInspection] = useState(false)

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

  const loadInspectionStatus = useCallback(async () => {
    setLoadingInspectionStatus(true)
    try {
      const [inspections, closedDays] = await Promise.all([
        fetchInspections({ date }),
        fetchClosedDays({ month: date.slice(0, 7) }),
      ])
      setInspectionStatus({
        existing: inspections.find((i) => i.building === INSPECTION_BUILDING) || null,
        closed: closedDays.includes(date),
      })
    } catch {
      // 状態が取れなくてもボタン自体は出す（開けば新規記録として入力できる）
      setInspectionStatus({ existing: null, closed: false })
    } finally {
      setLoadingInspectionStatus(false)
    }
  }, [date])

  // 開いている間は裏の一覧を固定する。これが無いと、モーダル内のスクロールが
  // 裏の一覧へ伝わり、iPhoneで見出しが画面上端の外へ隠れることがあった（2026-08-10）
  useBodyScrollLock()

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!isOwner) loadInspectionStatus()
  }, [loadInspectionStatus, isOwner])

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
      <div className="ui-overlay is-top" role="dialog" aria-modal="true" onClick={handleClose}>
        <div className="ui-modal report-detail-modal" onClick={(e) => e.stopPropagation()}>
          <div className="ui-modal-head report-detail-head">
            <h2 className="ui-page-title">
              {formatReportDate(date)}
              {isToday && <span className="report-today-badge">本日</span>}
            </h2>
            <div className="report-head-right">
              {savedAt && <span className="report-saved">保存しました</span>}
              {/* 自主点検の入力ショートカット（2026-08-18。日報一覧・カレンダーの
                  チェックマークアイコンと同じ入力ウインドウをここからも開けるようにした。
                  残留塩素は専用画面の「＋」・行タップから記録する動線のまま変更していない */}
              {!readOnly && (
                <button
                  type="button"
                  className="icon-btn-inspection"
                  onClick={() => setEditingInspection(true)}
                  disabled={loadingInspectionStatus}
                  aria-label="自主点検を記録"
                  title="自主点検を記録"
                >
                  <IconCheckCircle size={20} />
                  <span className="icon-btn-inspection-label">自主点検</span>
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

          <div className="ui-modal-body">
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
              </div>
              {/* 開始・終了は必ず1行横並びにする（2026-08-19。作業者の枠と混ざって折り返すと
                  ペアが崩れるため別の report-fields に分け、is-halves で幅を2等分する） */}
              <div className="report-fields is-halves">
                <label className="report-field">
                  <span>開始</span>
                  <TimeInput
                    value={toHHMM(report.work_start)}
                    disabled={readOnly}
                    onChange={(v) => patchHeader({ work_start: v })}
                  />
                </label>
                <label className="report-field">
                  <span>終了</span>
                  <TimeInput
                    value={toHHMM(report.work_end)}
                    disabled={readOnly}
                    onChange={(v) => patchHeader({ work_end: v })}
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
                    <TimeInput
                      className="entry-time"
                      value={toHHMM(e.entry_time)}
                      disabled={readOnly}
                      onChange={(v) => handleEntryChange(e.id, { entry_time: v })}
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

      {/* ヘッダの「自主点検」ボタンから開く入力ウインドウ（2026-08-18） */}
      {editingInspection && (
        <InspectionForm
          date={date}
          building={INSPECTION_BUILDING}
          existing={inspectionStatus.existing}
          initialClosed={inspectionStatus.closed}
          defaultInspector={user?.display_name || ''}
          onClose={() => setEditingInspection(false)}
          onSaved={() => {
            setEditingInspection(false)
            loadInspectionStatus()
          }}
          onDelete={async (id) => {
            try {
              await deleteInspection(id)
            } catch (err) {
              setError(err.message)
            } finally {
              setEditingInspection(false)
              loadInspectionStatus()
            }
          }}
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
