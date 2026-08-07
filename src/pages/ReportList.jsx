import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import {
  IconClipboard,
  IconGear,
  IconCar,
  IconClip,
  IconCheckCircle,
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
  fetchInspections,
  INSPECTION_BUILDINGS,
  weekdayInfo,
  currentMonthJST,
  shiftMonth,
  daysInMonth,
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

  const [month, setMonth] = useState(currentMonthJST())
  const [reports, setReports] = useState([])
  const [closedDays, setClosedDays] = useState(new Set())
  const [inspectedDates, setInspectedDates] = useState(new Set())
  const [holidays, setHolidays] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 未入力の行タップで新規作成中（多重タップ防止）
  const [creating, setCreating] = useState(false)

  const today = todayJST()
  const building = INSPECTION_BUILDINGS[0]

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [list, closed, inspections] = await Promise.all([
        fetchReports(),
        fetchClosedDays({ month }),
        fetchInspections({ month }),
      ])
      setReports(list)
      setClosedDays(new Set(closed))
      setInspectedDates(new Set(inspections.filter((i) => i.building === building).map((i) => i.inspected_on)))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [month, building])

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

  // 未入力の行をタップすると新規作成してそのまま詳細を開く（2026-08-07。上部の「＋」ボタンを廃止）。
  // 何も入力しないまま詳細画面のホームボタンで戻った場合は、詳細画面側でこの日報をロールバック（削除）する
  async function handleCreateAndOpen(date) {
    if (isOwner || creating) return
    setCreating(true)
    setError('')
    try {
      await createReport(date)
      navigate(`/reports/${date}`)
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
            {/* 自主検査表はハンバーガーメニューに入れず、この画面の見える位置に置く
                （2026-08-05のご指摘）。定型文の設定は滅多に使わないため、歯車アイコンのみ
                にしている（2026-08-05 追加調整）。「自主検査入力」は日報詳細画面へ移動した
                （2026-08-07。該当の日を開いてから記録する運用にするため）。 */}
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
              const isTodayRow = date === today

              if (r) {
                const entries = (r.entries || []).filter((e) => e.content)
                return (
                  <li key={date}>
                    <button
                      type="button"
                      className={`report-row${isTodayRow ? ' is-today' : ''}`}
                      onClick={() => navigate(`/reports/${date}`)}
                    >
                      <div className="report-row-main">
                        <div className="report-row-date">
                          <span className={`report-date ${wd.className}`}>{formatReportDate(date)}</span>
                          {isTodayRow && <span className="report-today-badge">本日</span>}
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
                      {/* 右端のアイコン3種（違反車両／添付画像／自主点検）。左から順に固定位置で並べ、
                          該当しないものは場所だけ残して非表示にする（2026-08-05。2026-08-07に
                          自主点検の実施有無アイコンを追加し、位置固定に変更）。自主点検は当日以前で
                          未実施のときだけ黄色い丸で目立たせる */}
                      <div className="report-row-icons">
                        <span className={`report-row-icon${r.has_parking ? '' : ' is-hidden'}`} title="違反車両あり">
                          <IconCar size={20} />
                        </span>
                        <span className={`report-row-icon${r.has_photos ? '' : ' is-hidden'}`} title="添付画像あり">
                          <IconClip size={20} />
                        </span>
                        <span
                          className={`report-row-icon report-inspection-icon${
                            inspectedDates.has(date) ? ' is-done' : !isFuture ? ' is-pending' : ''
                          }`}
                          title={inspectedDates.has(date) ? '自主点検実施済み' : '自主点検未実施'}
                        >
                          <IconCheckCircle size={18} />
                        </span>
                      </div>
                    </button>
                  </li>
                )
              }

              // 未入力・未来日でもない日は行タップで新規作成できる。他の要素（休館日ボタン）を
              // 内包するため <button> ではなく role="button" の <div> にしている
              const clickable = !isOwner && !closed && !isFuture
              const rowClass = [
                'report-day-row',
                closed && 'is-closed',
                isTodayRow && 'is-today',
                clickable && 'is-clickable',
              ]
                .filter(Boolean)
                .join(' ')

              return (
                <li key={date}>
                  <div
                    className={rowClass}
                    onClick={clickable ? () => handleCreateAndOpen(date) : undefined}
                    role={clickable ? 'button' : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    aria-disabled={clickable ? creating : undefined}
                    onKeyDown={
                      clickable
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              handleCreateAndOpen(date)
                            }
                          }
                        : undefined
                    }
                  >
                    <div className="report-day-row-date">
                      <span className={`report-date ${wd.className}`}>{formatReportDate(date)}</span>
                      {isTodayRow && <span className="report-today-badge">本日</span>}
                      <span className="report-day-empty-label">{closed ? '休館日' : '未入力'}</span>
                    </div>
                    {!isOwner && closed && (
                      <button
                        type="button"
                        className="btn-plain report-day-row-action"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleUnmarkClosed(date)
                        }}
                      >
                        休館日を解除
                      </button>
                    )}
                    {!isOwner && !closed && !isFuture && (
                      <button
                        type="button"
                        className="btn-plain report-day-row-action"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleMarkClosed(date)
                        }}
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
    </div>
  )
}
