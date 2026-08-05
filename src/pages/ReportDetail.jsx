import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import ReportPhotos from '../components/ReportPhotos'
import ConfirmDeleteButton from '../components/ConfirmDeleteButton'
import { IconHome, IconChevronLeft, IconChevronRight } from '../components/Icons'
import { getCurrentUser } from '../lib/auth'
import {
  fetchReport,
  createReport,
  updateReport,
  addEntry,
  updateEntry,
  deleteEntry,
  fetchTemplates,
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

  const [report, setReport] = useState(null)
  const [entries, setEntries] = useState([])
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [savedAt, setSavedAt] = useState(null)

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
          <button
            type="button"
            className="icon-btn-home"
            onClick={() => navigate('/reports')}
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
          <div className="report-head-right">{savedAt && <span className="report-saved">保存しました</span>}</div>
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
              <h3 className="report-card-title">作業者・時間</h3>
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
                {entries.map((e) => (
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
                      <ConfirmDeleteButton onConfirm={() => handleDeleteEntry(e.id)} label="この記録を削除" size={18} />
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
          </>
        )}
      </div>
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
