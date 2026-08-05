import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import { IconClipboard, IconGear } from '../components/Icons'
import { getCurrentUser } from '../lib/auth'
import {
  fetchReports,
  createReport,
  todayJST,
  formatReportDate,
  toHHMM,
  fetchHolidays,
  weekdayInfo,
} from '../lib/reports'
import './Dashboard.css'

// 一覧に出す作業記録の抜粋の行数（現行 FileMaker の一覧に合わせて3行程度）
const PREVIEW_LINES = 3

export default function ReportList() {
  const navigate = useNavigate()
  const user = getCurrentUser()
  const isOwner = user?.role === 'owner'

  const [reports, setReports] = useState([])
  const [holidays, setHolidays] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  const today = todayJST()
  const hasToday = reports.some((r) => r.report_date === today)

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
            {/* 自主検査表・定型文の設定はハンバーガーメニューに入れず、
                この画面の見える位置に並べて置く（2026-08-05のご指摘） */}
            <button type="button" className="btn-plain" onClick={() => navigate('/reports/inspections')}>
              <IconClipboard size={18} />
              自主検査表
            </button>
            {!isOwner && (
              <button type="button" className="btn-plain" onClick={() => navigate('/reports/templates')}>
                <IconGear size={18} />
                定型文の設定
              </button>
            )}
            {!isOwner && (
              <button type="button" className="btn-primary" onClick={openToday} disabled={creating}>
                {creating ? '準備中…' : hasToday ? '本日の日報を開く' : '＋ 本日の日報をつくる'}
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
          <ul className="report-list">
            {reports.map((r) => {
              const entries = (r.entries || []).filter((e) => e.content)
              const wd = weekdayInfo(r.report_date, holidays)
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    className={`report-row${r.report_date === today ? ' is-today' : ''}`}
                    onClick={() => navigate(`/reports/${r.report_date}`)}
                  >
                    <div className="report-row-date">
                      <span className={`report-date ${wd.className}`}>{formatReportDate(r.report_date)}</span>
                      {r.report_date === today && <span className="report-today-badge">本日</span>}
                      <span className="report-workers">
                        午前：{r.worker_am || '—'}　午後：{r.worker_pm || '—'}
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
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
