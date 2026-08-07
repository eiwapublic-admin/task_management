import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import ReportPhotos from '../components/ReportPhotos'
import ReportParkingViolations from '../components/ReportParkingViolations'
import ConfirmDeleteButton from '../components/ConfirmDeleteButton'
import InspectionForm from '../components/InspectionForm'
import { IconHome, IconChevronLeft, IconChevronRight, IconClipboard } from '../components/Icons'
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
  INSPECTION_BUILDINGS,
  shiftDate,
  todayJST,
  formatReportDate,
  toHHMM,
} from '../lib/reports'
import './Dashboard.css'

// 作業者の選択肢。設定の担当者名と揃えているが、日報側は「その他」も選べるようにする
const WORKERS = ['岡田', '西川', '橋口']

// 入力の取りこぼしを防ぐため、変更から少し待って自動保存する
const AUTOSAVE_MS = 800

export default function ReportDetail() {
  const { date } = useParams()
  const navigate = useNavigate()
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

  // 自主検査入力モーダル（この日の分を直接記録するショートカット。2026-08-07）
  const [inspectionOpen, setInspectionOpen] = useState(false)
  const [inspectionLoading, setInspectionLoading] = useState(false)
  const [dateInspection, setDateInspection] = useState(null)
  const [dateInspectionClosed, setDateInspectionClosed] = useState(false)

  // 明細の自動保存タイマー（明細IDごと）
  const timers = useRef(new Map())

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

  function markSaved() {
    setSavedAt(new Date())
  }

  // 表示は常に時刻順にする（保存順＝sort_orderとは独立。時刻が同じ／未入力なものは
  // 追加順を維持するため sort_order をタイブレークに使う。2026-08-07）
  const sortedEntries = useMemo(() => {
    return [...entries].sort((a, b) => {
      const at = a.entry_time || '99:99:99'
      const bt = b.entry_time || '99:99:99'
      if (at !== bt) return at < bt ? -1 : 1
      return a.sort_order - b.sort_order
    })
  }, [entries])

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

  // ホームに戻る。未入力（明細・写真・違反車両のいずれも無い）まま離れる場合は、
  // 一覧の行タップで自動作成された空の日報を残さないよう削除する（2026-08-07）
  async function handleGoHome() {
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
        // ロールバック判定に失敗しても画面遷移自体は妨げない
      }
    }
    navigate('/reports')
  }

  async function handleDeleteReport() {
    if (!report || readOnly) return
    setError('')
    try {
      await deleteReport(report.id)
      navigate('/reports')
    } catch (err) {
      setError(err.message)
    }
  }

  // 「休館日」指定。この日の日報を削除し、休館日として登録してから一覧へ戻る
  // （休館日は日報を持たない日という扱いのため。/api/report/closed-days 参照）
  async function handleMarkDayClosed() {
    if (!report || readOnly) return
    setError('')
    try {
      await deleteReport(report.id)
      await markClosedDay(date)
      navigate('/reports')
    } catch (err) {
      setError(err.message)
      load()
    }
  }

  async function openInspection() {
    setInspectionLoading(true)
    setError('')
    try {
      const [list, closed] = await Promise.all([
        fetchInspections({ date }),
        fetchClosedDays({ month: date.slice(0, 7) }),
      ])
      setDateInspection(list[0] || null)
      setDateInspectionClosed(closed.includes(date))
      setInspectionOpen(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setInspectionLoading(false)
    }
  }

  function handleInspectionSaved() {
    setInspectionOpen(false)
  }

  async function handleInspectionDelete(id) {
    try {
      await deleteInspection(id)
    } catch (err) {
      setError(err.message)
    }
    setInspectionOpen(false)
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

  return (
    <div className="reports-page">
      <AppHeader />
      <div className="reports-container">
        <div className="report-detail-head">
          <div className="report-detail-head-left">
            <button
              type="button"
              className="icon-btn-home"
              onClick={handleGoHome}
              aria-label="日報一覧に戻る"
              title="日報一覧に戻る"
            >
              <IconHome size={32} />
            </button>
            <div className="report-nav">
              <button
                type="button"
                className="icon-btn-nav"
                onClick={() => navigate(`/reports/${shiftDate(date, -1)}`)}
                aria-label="前日"
                title="前日"
              >
                <IconChevronLeft size={28} />
              </button>
              <h2 className="page-title">
                {formatReportDate(date)}
                {isToday && <span className="report-today-badge">本日</span>}
              </h2>
              <button
                type="button"
                className="icon-btn-nav"
                onClick={() => navigate(`/reports/${shiftDate(date, 1)}`)}
                aria-label="翌日"
                title="翌日"
              >
                <IconChevronRight size={28} />
              </button>
            </div>
          </div>
          <div className="report-head-right">
            {savedAt && <span className="report-saved">保存しました</span>}
            {!readOnly && (
              <button type="button" className="btn-plain" onClick={openInspection} disabled={inspectionLoading}>
                <IconClipboard size={18} />
                {inspectionLoading ? '読み込み中…' : '自主検査入力'}
              </button>
            )}
            {!readOnly && report && (
              <span className="report-head-delete">
                <ConfirmDeleteButton onConfirm={handleDeleteReport} label="この日の日報を削除" size={22} />
              </span>
            )}
          </div>
        </div>

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

      {inspectionOpen && (
        <InspectionForm
          date={date}
          building={building}
          existing={dateInspection}
          initialClosed={dateInspectionClosed}
          defaultInspector={user?.display_name || ''}
          onClose={() => setInspectionOpen(false)}
          onSaved={handleInspectionSaved}
          onDelete={handleInspectionDelete}
        />
      )}
    </div>
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
