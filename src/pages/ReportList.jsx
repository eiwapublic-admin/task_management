import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import { IconClipboard, IconGear, IconCar, IconClip, IconChevronRight } from '../components/Icons'
import { getCurrentUser } from '../lib/auth'
import {
  fetchReports,
  createReport,
  todayJST,
  formatReportDate,
  toHHMM,
  fetchHolidays,
  weekdayInfo,
  currentMonthJST,
  shiftMonth,
} from '../lib/reports'
import './Dashboard.css'

// 一覧に出す作業記録の抜粋の行数（現行 FileMaker の一覧に合わせて3行程度）
const PREVIEW_LINES = 3

// 'YYYY-MM' → '2026年8月'
function formatMonthLabel(month) {
  const [y, m] = month.split('-')
  return `${y}年${Number(m)}月`
}

export default function ReportList() {
  const navigate = useNavigate()
  const user = getCurrentUser()
  const isOwner = user?.role === 'owner'

  const [reports, setReports] = useState([])
  const [holidays, setHolidays] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  // 月ごとにトグル開閉できるようにする（2026-08-06）。直近2ヶ月分（今月・先月）は
  // 見た目の初期状態として開き、それより古い月は畳んでおく。
  const [openMonths, setOpenMonths] = useState(() => {
    const thisMonth = currentMonthJST()
    return new Set([thisMonth, shiftMonth(thisMonth, -1)])
  })

  const today = todayJST()
  const hasToday = reports.some((r) => r.report_date === today)

  // report_date は新しい順に取得済みのため、月ごとにまとめても月の並びは崩れない
  const monthGroups = useMemo(() => {
    const map = new Map()
    for (const r of reports) {
      const month = r.report_date.slice(0, 7)
      if (!map.has(month)) map.set(month, [])
      map.get(month).push(r)
    }
    return [...map.entries()]
  }, [reports])

  function toggleMonth(month) {
    setOpenMonths((prev) => {
      const next = new Set(prev)
      if (next.has(month)) next.delete(month)
      else next.add(month)
      return next
    })
  }

  useEffect(() => {
    fetchReports()
      .then(setReports)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  // 土曜=青、日曜・祝日=赤の色分けに使う。取れなくても一覧自体は表示できるようにする
  useEffect(() => {
    fetchHolidays()
      .then(setHolidays)
      .catch(() => setHolidays({}))
  }, [])

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

  return (
    <div className="reports-page">
      <AppHeader />
      <div className="reports-container">
        <div className="reports-toolbar">
          <h2 className="page-title">日報</h2>
          <div className="reports-toolbar-actions">
            {/* 「本日の日報をつくる」は＋アイコンのみにして一番左端に置き、本日分が
                未作成のときだけ表示する（2026-08-05）。iPhoneでもツールバーが1行に
                収まるようにするため。自主検査表はハンバーガーメニューに入れず、この
                画面の見える位置に置く（2026-08-05のご指摘）。定型文の設定は滅多に
                使わないため、歯車アイコンのみにしている（2026-08-05 追加調整）。 */}
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
        ) : reports.length === 0 ? (
          <p className="settings-hint">まだ日報がありません。</p>
        ) : (
          monthGroups.map(([month, monthReports]) => {
            const isOpen = openMonths.has(month)
            return (
              <div className="report-month-group" key={month}>
                <button
                  type="button"
                  className="report-month-toggle"
                  aria-expanded={isOpen}
                  onClick={() => toggleMonth(month)}
                >
                  <IconChevronRight size={16} className={`report-month-chevron${isOpen ? ' is-open' : ''}`} />
                  <span className="report-month-label">{formatMonthLabel(month)}</span>
                  <span className="report-month-count">{monthReports.length} 件</span>
                </button>
                {isOpen && (
                  <ul className="report-list">
                    {monthReports.map((r) => {
                      const entries = (r.entries || []).filter((e) => e.content)
                      const wd = weekdayInfo(r.report_date, holidays)
                      return (
                        <li key={r.id}>
                          <button
                            type="button"
                            className={`report-row${r.report_date === today ? ' is-today' : ''}`}
                            onClick={() => navigate(`/reports/${r.report_date}`)}
                          >
                            <div className="report-row-main">
                              <div className="report-row-date">
                                <span className={`report-date ${wd.className}`}>
                                  {formatReportDate(r.report_date)}
                                </span>
                                {r.report_date === today && <span className="report-today-badge">本日</span>}
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
                    })}
                  </ul>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
