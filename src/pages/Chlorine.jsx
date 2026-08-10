import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import ChlorineForm from '../components/ChlorineForm'
import useChlorinePdfExport from '../hooks/useChlorinePdfExport'
import { IconHome, IconDownload, IconDroplet } from '../components/Icons'
import { getCurrentUser } from '../lib/auth'
import {
  CHLORINE_BUILDINGS,
  CHLORINE_JUDGEMENT_ITEMS,
  CHLORINE_STANDARD_MIN,
  fetchChlorineTests,
  deleteChlorineTest,
  formatConcentration,
  formatReportDate,
  currentYearJST,
  fetchHolidays,
  weekdayInfo,
} from '../lib/reports'
import './Dashboard.css'
// AttachmentPreview（PDFのアプリ内プレビュー）の見た目はタスク管理側の KanbanBoard.css で
// 定義されているため、この画面を直接開いた場合に備えて明示的に import しておく
// （Inspections.jsx / ReportList.jsx と同じ対応）。
import '../components/KanbanBoard.css'

// 一覧に出す年の選択肢。運用開始前の年まで遡れても意味が無いので、直近5年分を出す
const YEAR_CHOICES = 5

// 残留塩素等検査（Phase 5。2026-08-10）。
// 現行アプリ（FileMaker）の「残留塩素濃度_TOP」「検査一覧」「帳票」に相当する画面を
// 1画面にまとめたもの。日を跨って一覧できるよう、違反車両一覧と同じく日報とは独立した
// 画面にし、各記録から当日の日報へ戻れるようにしている。
export default function Chlorine() {
  const navigate = useNavigate()
  const user = getCurrentUser()
  const readOnly = user?.role === 'owner'

  const [year, setYear] = useState(currentYearJST())
  // 一覧の絞り込み（''＝全施設）。帳票の出力対象はこれとは別に選ぶ
  const [filterBuilding, setFilterBuilding] = useState('')
  const [pdfBuilding, setPdfBuilding] = useState(CHLORINE_BUILDINGS[0])
  const [tests, setTests] = useState([])
  const [holidays, setHolidays] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 入力モーダル。'new' なら新規、レコードなら編集
  const [editing, setEditing] = useState(null)
  const pdf = useChlorinePdfExport(year, pdfBuilding)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setTests(await fetchChlorineTests({ year }))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [year])

  useEffect(() => {
    load()
  }, [load])

  // 祝日は日付の色分けに使うだけなので、取得できなくても表示は続ける
  useEffect(() => {
    fetchHolidays()
      .then(setHolidays)
      .catch(() => setHolidays({}))
  }, [])

  const years = useMemo(() => {
    const current = currentYearJST()
    return Array.from({ length: YEAR_CHOICES }, (_, i) => current - i)
  }, [])

  // 測定日ごとにまとめる（現行アプリの一覧と同じ「日付見出し＋その日の測定行」の並び）
  const groups = useMemo(() => {
    const filtered = filterBuilding ? tests.filter((t) => t.building === filterBuilding) : tests
    const map = new Map()
    for (const t of filtered) {
      // 測定日はJSTの日付で見る（tested_at はタイムゾーン付きで持っている）
      const date = new Date(t.tested_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
      if (!map.has(date)) map.set(date, [])
      map.get(date).push(t)
    }
    return [...map.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([date, rows]) => ({
        date,
        rows: rows.sort((a, b) => new Date(a.tested_at) - new Date(b.tested_at)),
      }))
  }, [tests, filterBuilding])

  function handleSaved(saved) {
    setTests((prev) => [saved, ...prev.filter((t) => t.id !== saved.id)])
    setEditing(null)
    // 測定日を変更した場合など、一覧の並び・対象年が変わりうるので取り直す
    load()
  }

  async function handleDelete(id) {
    setTests((prev) => prev.filter((t) => t.id !== id))
    setEditing(null)
    try {
      await deleteChlorineTest(id)
    } catch (err) {
      setError(err.message)
      load()
    }
  }

  function formatTime(value) {
    return new Date(value).toLocaleTimeString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  }

  return (
    <div className="reports-page">
      <AppHeader />
      <div className="reports-container">
        <div className="reports-toolbar">
          <button
            type="button"
            className="icon-btn-home"
            onClick={() => navigate('/reports')}
            aria-label="日報一覧に戻る"
            title="日報一覧に戻る"
          >
            <IconHome size={32} />
          </button>
          <h2 className="page-title">残留塩素等検査</h2>
          <div className="reports-toolbar-actions">
            {!readOnly && (
              <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
                <IconDroplet size={18} />
                測定を記録
              </button>
            )}
          </div>
        </div>

        {/* 一覧の絞り込み（年・施設）。年は帳票の出力対象年も兼ねる */}
        <div className="chlorine-controls">
          <label className="report-field">
            <span>対象年</span>
            <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y} 年
                </option>
              ))}
            </select>
          </label>
          <label className="report-field">
            <span>測定施設（一覧）</span>
            <select value={filterBuilding} onChange={(e) => setFilterBuilding(e.target.value)}>
              <option value="">すべて</option>
              {CHLORINE_BUILDINGS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* 帳票の出力（現行アプリの「帳票の出力（年・測定施設）」に相当）。
            年は上の「対象年」をそのまま使い、施設だけここで選ぶ */}
        <div className="chlorine-pdf-bar">
          <span className="chlorine-pdf-label">帳票の出力</span>
          <label className="report-field">
            <span>測定施設</span>
            <select value={pdfBuilding} onChange={(e) => setPdfBuilding(e.target.value)}>
              {CHLORINE_BUILDINGS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn-plain"
            onClick={pdf.download}
            disabled={pdf.busy || loading}
            title={`${year}年の${pdfBuilding}分を「残留塩素等検査実施記録表」としてPDFに出力する`}
          >
            <IconDownload size={18} />
            {pdf.busy ? '作成中…' : '残留塩素等検査一覧表出力'}
          </button>
        </div>

        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}

        {pdf.error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {pdf.error}
          </p>
        )}

        {loading ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : groups.length === 0 ? (
          <p className="settings-hint">{year} 年の測定記録はまだありません。</p>
        ) : (
          <div className="chlorine-list">
            {groups.map((g) => {
              const wd = weekdayInfo(g.date, holidays)
              return (
                <section className="chlorine-day" key={g.date}>
                  <h3 className={`chlorine-day-head ${wd.className}`}>{formatReportDate(g.date)}</h3>
                  <ul className="chlorine-rows">
                    {g.rows.map((t) => {
                      const below =
                        t.concentration !== null &&
                        t.concentration !== undefined &&
                        Number(t.concentration) < CHLORINE_STANDARD_MIN
                      const ngItems = CHLORINE_JUDGEMENT_ITEMS.filter((i) => t[i.key] === false)
                      return (
                        <li key={t.id}>
                          <div
                            className={`chlorine-row${readOnly ? '' : ' is-clickable'}`}
                            onClick={readOnly ? undefined : () => setEditing(t)}
                            role={readOnly ? undefined : 'button'}
                            tabIndex={readOnly ? undefined : 0}
                            onKeyDown={
                              readOnly
                                ? undefined
                                : (e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault()
                                      setEditing(t)
                                    }
                                  }
                            }
                          >
                            <span className="chlorine-row-building">{t.building}</span>
                            <span className="chlorine-row-time">{formatTime(t.tested_at)}</span>
                            <span className={`chlorine-row-value${below ? ' is-below' : ''}`}>
                              {formatConcentration(t.concentration) || '—'}
                            </span>
                            <span className="chlorine-row-location">{t.location || ''}</span>
                            <span className="chlorine-row-inspector">{t.inspector || ''}</span>
                            {ngItems.length > 0 && (
                              <span className="chlorine-row-ng">
                                {ngItems.map((i) => i.label).join('・')} NG
                              </span>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            })}
          </div>
        )}

        <p className="settings-hint chlorine-legend">
          週1回検査／水道水質基準: 遊離残留塩素濃度として {CHLORINE_STANDARD_MIN.toFixed(1)}mg/L 以上
        </p>
      </div>

      {pdf.sheetsPortal}

      {editing && (
        <ChlorineForm
          key={editing === 'new' ? 'new' : editing.id}
          existing={editing === 'new' ? null : editing}
          defaultBuilding={filterBuilding || CHLORINE_BUILDINGS[0]}
          defaultInspector={user?.display_name || ''}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
          onDelete={handleDelete}
        />
      )}

      {pdf.previewModal}
    </div>
  )
}
