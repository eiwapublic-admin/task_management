import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import InspectionForm from '../components/InspectionForm'
import {
  IconClipboard,
  IconGear,
  IconCar,
  IconClip,
  IconChevronLeft,
  IconChevronRight,
} from '../components/Icons'
import { getCurrentUser } from '../lib/auth'
import {
  fetchReports,
  createReport,
  todayJST,
  formatReportDate,
  toHHMM,
  fetchHolidays,
  fetchClosedDays,
  markClosedDay,
  unmarkClosedDay,
  weekdayInfo,
  currentMonthJST,
  shiftMonth,
  daysInMonth,
  fetchInspections,
  deleteInspection,
  INSPECTION_BUILDINGS,
} from '../lib/reports'
import './Dashboard.css'

// 一覧に出す作業記録の抜粋の行数（現行 FileMaker の一覧に合わせて3行程度）
const PREVIEW_LINES = 3

// 自主検査表（Inspections.jsx）と同じ「月単位・＜＞で移動・1日から全日表示」の構成にする
// （2026-08-07）。休館日はプロジェクト共通情報（closed_days）のため自主検査表とも共有する。
export default function ReportList() {
  const navigate = useNavigate()
  const user = getCurrentUser()
  const isOwner = user?.role === 'owner'
  const building = INSPECTION_BUILDINGS[0]

  const [month, setMonth] = useState(currentMonthJST())
  const [reports, setReports] = useState([])
  const [closedDays, setClosedDays] = useState(new Set())
  const [holidays, setHolidays] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  // 自主検査表の当日分入力モーダル（右上の「自主検査入力」ボタンから開く）
  const [inspectionOpen, setInspectionOpen] = useState(false)
  const [inspectionLoading, setInspectionLoading] = useState(false)
  const [todayInspection, setTodayInspection] = useState(null)
  const [todayInspectionClosed, setTodayInspectionClosed] = useState(false)

  const today = todayJST()
  const hasToday = reports.some((r) => r.report_date === today)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [list, closed] = await Promise.all([fetchReports(), fetchClosedDays({ month })])
      setReports(list)
      setClosedDays(new Set(closed))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [month])

  useEffect(() => {
    load()
  }, [load])

  // 土曜=青、日曜・祝日=赤の色分けに使う。取れなくても一覧自体は表示できるようにする
  useEffect(() => {
    fetchHolidays()
      .then(setHolidays)
      .catch(() => setHolidays({}))
  }, [])

  const days = useMemo(() => {
    const count = daysInMonth(month)
    return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)
  }, [month])

  const reportsByDate = useMemo(() => {
    const map = new Map()
    for (const r of reports) map.set(r.report_date, r)
    return map
  }, [reports])

  // 本日分をまだ作っていなければ作ってから開く。既にあればそのまま開く（APIが冪等）
  async function openToday() {
    setCreating(true)
    setError('')
    try {
      await createReport(today)
      navigate(`/reports/${today}`)
    } catch (err) {
      setError(err.message)
      setCreating(false)
    }
  }

  async function handleMarkClosed(date) {
    setError('')
    try {
      await markClosedDay(date)
      setClosedDays((prev) => new Set(prev).add(date))
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleUnmarkClosed(date) {
    setError('')
    try {
      await unmarkClosedDay(date)
      setClosedDays((prev) => {
        const next = new Set(prev)
        next.delete(date)
        return next
      })
    } catch (err) {
      setError(err.message)
    }
  }

  // 「自主検査入力」ボタン。当日分の既存記録・休館日状態を取得してからモーダルを開く
  async function openTodayInspection() {
    setInspectionLoading(true)
    setError('')
    try {
      const [list, closed] = await Promise.all([
        fetchInspections({ date: today }),
        fetchClosedDays({ month: today.slice(0, 7) }),
      ])
      setTodayInspection(list[0] || null)
      setTodayInspectionClosed(closed.includes(today))
      setInspectionOpen(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setInspectionLoading(false)
    }
  }

  function handleInspectionSaved(result) {
    setInspectionOpen(false)
    // 表示中の月の休館日一覧にも反映する（当日が表示中の月に含まれる場合のみ意味を持つ）
    if (result.inspected_on.slice(0, 7) === month) {
      setClosedDays((prev) => {
        const next = new Set(prev)
        if (result.closed) next.add(result.inspected_on)
        else next.delete(result.inspected_on)
        return next
      })
    }
  }

  async function handleInspectionDelete(id) {
    try {
      await deleteInspection(id)
    } catch (err) {
      setError(err.message)
    }
    setInspectionOpen(false)
  }

  return (
    <div className="reports-page">
      <AppHeader />
      <div className="reports-container">
        <div className="reports-toolbar">
          <div className="inspection-month">
            <button
              type="button"
              className="icon-btn-nav"
              onClick={() => setMonth(shiftMonth(month, -1))}
              aria-label="前月"
              title="前月"
            >
              <IconChevronLeft size={28} />
            </button>
            <span className="inspection-month-label">{month.replace('-', '年')}月</span>
            <button
              type="button"
              className="icon-btn-nav"
              onClick={() => setMonth(shiftMonth(month, 1))}
              aria-label="翌月"
              title="翌月"
            >
              <IconChevronRight size={28} />
            </button>
          </div>
          <h2 className="page-title">日報</h2>
          <div className="reports-toolbar-actions">
            {/* 「本日の日報をつくる」は＋アイコンのみにして一番左端に置き、本日分が
                未作成のときだけ表示する（2026-08-05）。iPhoneでもツールバーが1行に
                収まるようにするため。自主検査表はハンバーガーメニューに入れず、この
                画面の見える位置に置く（2026-08-05のご指摘）。定型文の設定は滅多に
                使わないため、歯車アイコンのみにしている（2026-08-05 追加調整）。
                自主検査入力は当日分をこの画面から直接記録できるショートカット（2026-08-07）。 */}
            {!isOwner && !hasToday && (
              <button
                type="button"
                className="icon-btn-add"
                onClick={openToday}
                disabled={creating}
                aria-label="本日の日報をつくる"
                title="本日の日報をつくる"
              >
                {creating ? '…' : '＋'}
              </button>
            )}
            {!isOwner && (
              <button
                type="button"
                className="btn-plain"
                onClick={openTodayInspection}
                disabled={inspectionLoading}
              >
                <IconClipboard size={18} />
                {inspectionLoading ? '読み込み中…' : '自主検査入力'}
              </button>
            )}
            <button type="button" className="btn-plain" onClick={() => navigate('/reports/inspections')}>
              <IconClipboard size={18} />
              自主検査表
            </button>
            <button type="button" className="btn-plain" onClick={() => navigate('/reports/parking')}>
              <IconCar size={18} />
              違反車両
            </button>
            {!isOwner && (
              <button
                type="button"
                className="icon-btn-gear"
                onClick={() => navigate('/reports/templates')}
                aria-label="定型文の設定"
                title="定型文の設定"
              >
                <IconGear size={20} />
              </button>
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
        ) : (
          <ul className="report-list">
            {days.map((date) => {
              const r = reportsByDate.get(date)
              const closed = closedDays.has(date)
              const wd = weekdayInfo(date, holidays)
              const isFuture = date > today

              if (r) {
                const entries = (r.entries || []).filter((e) => e.content)
                return (
                  <li key={date}>
                    <button
                      type="button"
                      className={`report-row${date === today ? ' is-today' : ''}`}
                      onClick={() => navigate(`/reports/${date}`)}
                    >
                      <div className="report-row-main">
                        <div className="report-row-date">
                          <span className={`report-date ${wd.className}`}>{formatReportDate(date)}</span>
                          {date === today && <span className="report-today-badge">本日</span>}
                          <span className="report-workers">
                            {r.worker_am || '—'} | {r.worker_pm || '—'}
                          </span>
                        </div>
                        <div className="report-row-body">
                          {entries.length === 0 ? (
                            <span className="report-empty">記録なし</span>
                          ) : (
                            <>
                              {entries.slice(0, PREVIEW_LINES).map((e) => (
                                <div className="report-line" key={e.id}>
                                  <span className="report-line-time">{toHHMM(e.entry_time)}</span>
                                  <span className="report-line-text">{e.content}</span>
                                </div>
                              ))}
                              {entries.length > PREVIEW_LINES && (
                                <div className="report-more">ほか {entries.length - PREVIEW_LINES} 件</div>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                      {/* 右端のアイコン。違反車両があった日は車、写真がある日はクリップ（2026-08-05） */}
                      {(r.has_parking || r.has_photos) && (
                        <div className="report-row-icons">
                          {r.has_parking && <IconCar size={20} title="違反車両あり" />}
                          {r.has_photos && <IconClip size={20} title="写真あり" />}
                        </div>
                      )}
                    </button>
                  </li>
                )
              }

              return (
                <li key={date}>
                  <div className={`report-day-row${closed ? ' is-closed' : ''}`}>
                    <div className="report-day-row-date">
                      <span className={`report-date ${wd.className}`}>{formatReportDate(date)}</span>
                      {date === today && <span className="report-today-badge">本日</span>}
                      <span className="report-day-empty-label">{closed ? '休館日' : '未入力'}</span>
                    </div>
                    {!isOwner && closed && (
                      <button
                        type="button"
                        className="btn-plain report-day-row-action"
                        onClick={() => handleUnmarkClosed(date)}
                      >
                        休館日を解除
                      </button>
                    )}
                    {!isOwner && !closed && !isFuture && (
                      <button
                        type="button"
                        className="btn-plain report-day-row-action"
                        onClick={() => handleMarkClosed(date)}
                      >
                        休館日
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {inspectionOpen && (
        <InspectionForm
          date={today}
          building={building}
          existing={todayInspection}
          initialClosed={todayInspectionClosed}
          defaultInspector={user?.display_name || ''}
          onClose={() => setInspectionOpen(false)}
          onSaved={handleInspectionSaved}
          onDelete={handleInspectionDelete}
        />
      )}
    </div>
  )
}
