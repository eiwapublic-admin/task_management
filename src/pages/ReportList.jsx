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
  IconList,
  IconCalendar,
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
// カレンダー型の1日のマス目に出す作業記録の行数。リスト型より横幅が狭いため別に持つ。
// **表示分量は実際の画面を見ながら調整する予定（2026-08-07。この定数を変えるだけで済む）**
const CALENDAR_PREVIEW_LINES = 3

// カレンダー型を出せる下限幅（iPad縦=768pxを含める）。これ未満（＝スマートフォン）は
// マス目が狭すぎて実用にならないため、リスト型のみとする
const WIDE_SCREEN_QUERY = '(min-width: 768px)'

const WEEKDAY_HEADERS = ['日', '月', '火', '水', '木', '金', '土']

// 自主検査表（Inspections.jsx）と同じ「月単位・＜＞で移動・1日から全日表示」の構成にする
// （2026-08-07）。休館日はプロジェクト共通情報（closed_days）のため自主検査表とも共有する。
// 表示は「リスト型」と「カレンダー型」を切り替えられる（カレンダー型はPC/iPad専用。2026-08-07）。
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
  // 'list' | 'calendar'
  const [view, setView] = useState('list')
  // カレンダー型を出せる画面幅か。回転（iPadの縦横）にも追従させる
  const [isWideScreen, setIsWideScreen] = useState(
    () => typeof window === 'undefined' || window.matchMedia(WIDE_SCREEN_QUERY).matches,
  )

  const today = todayJST()
  const building = INSPECTION_BUILDINGS[0]

  // 狭い画面では常にリスト型にフォールバックする（state自体は保持し、広い画面に戻れば
  // 選んでいた表示に復帰する）
  const activeView = isWideScreen ? view : 'list'

  useEffect(() => {
    const mq = window.matchMedia(WIDE_SCREEN_QUERY)
    const onChange = (e) => setIsWideScreen(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

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

  // カレンダー型用に日曜始まりの週へ割り付ける。月初の前・月末の後は null（空マス）で埋める
  const weeks = useMemo(() => {
    const lead = new Date(`${month}-01T00:00:00Z`).getUTCDay()
    const cells = [...Array(lead).fill(null), ...days]
    while (cells.length % 7 !== 0) cells.push(null)
    const out = []
    for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7))
    return out
  }, [month, days])

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

  // 1日分の状態をまとめて求める。リスト型・カレンダー型で同じ判定を使う
  function dayState(date) {
    const r = reportsByDate.get(date)
    const closed = closedDays.has(date)
    const isFuture = date > today
    return {
      report: r,
      closed,
      isFuture,
      isToday: date === today,
      weekday: weekdayInfo(date, holidays),
      entries: r ? (r.entries || []).filter((e) => e.content) : [],
      // 未入力かつ未来日でなければタップで新規作成できる
      clickable: !r && !isOwner && !closed && !isFuture,
    }
  }

  // 右端のアイコン3種（違反車両／添付画像／自主点検）。左から順に固定位置で並べ、
  // 該当しないものは場所だけ残して非表示にする（2026-08-05。2026-08-07に自主点検の
  // 実施有無アイコンを追加し、位置固定に変更）。自主点検は当日以前で未実施のときだけ
  // 黄色い丸で目立たせる。リスト型・カレンダー型で共通して使う。
  function renderIcons(date, { report, isFuture }, size) {
    return (
      <div className="report-row-icons">
        <span className={`report-row-icon${report?.has_parking ? '' : ' is-hidden'}`} title="違反車両あり">
          <IconCar size={size} />
        </span>
        <span className={`report-row-icon${report?.has_photos ? '' : ' is-hidden'}`} title="添付画像あり">
          <IconClip size={size} />
        </span>
        <span
          className={`report-row-icon report-inspection-icon${
            inspectedDates.has(date) ? ' is-done' : !isFuture ? ' is-pending' : ''
          }`}
          title={inspectedDates.has(date) ? '自主点検実施済み' : '自主点検未実施'}
        >
          <IconCheckCircle size={size - 2} />
        </span>
      </div>
    )
  }

  // 休館日の指定／解除ボタン。リスト型・カレンダー型で共通
  function renderClosedDayButton(date, { closed, isFuture }, className) {
    if (isOwner) return null
    if (closed) {
      return (
        <button
          type="button"
          className={className}
          onClick={(e) => {
            e.stopPropagation()
            handleUnmarkClosed(date)
          }}
        >
          休館日を解除
        </button>
      )
    }
    if (isFuture) return null
    return (
      <button
        type="button"
        className={className}
        onClick={(e) => {
          e.stopPropagation()
          handleMarkClosed(date)
        }}
      >
        休館日
      </button>
    )
  }

  function renderList() {
    return (
      <ul className="report-list">
        {days.map((date) => {
          const st = dayState(date)
          const { report: r, closed, isToday, weekday: wd, entries } = st

          if (r) {
            return (
              <li key={date}>
                <button
                  type="button"
                  className={`report-row${isToday ? ' is-today' : ''}`}
                  onClick={() => navigate(`/reports/${date}`)}
                >
                  <div className="report-row-main">
                    <div className="report-row-date">
                      <span className={`report-date ${wd.className}`}>{formatReportDate(date)}</span>
                      {isToday && <span className="report-today-badge">本日</span>}
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
                  {renderIcons(date, st, 20)}
                </button>
              </li>
            )
          }

          // 未入力・未来日でもない日は行タップで新規作成できる。他の要素（休館日ボタン）を
          // 内包するため <button> ではなく role="button" の <div> にしている
          const clickable = st.clickable
          const rowClass = ['report-day-row', closed && 'is-closed', isToday && 'is-today', clickable && 'is-clickable']
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
                  {isToday && <span className="report-today-badge">本日</span>}
                  <span className="report-day-empty-label">{closed ? '休館日' : '未入力'}</span>
                </div>
                {renderClosedDayButton(date, st, 'btn-plain report-day-row-action')}
              </div>
            </li>
          )
        })}
      </ul>
    )
  }

  // カレンダー型（PC/iPad専用）。横軸は日曜〜土曜の7列で、画面幅いっぱいに広げる。
  // マス目の中身はリスト型と原則同じ（日付・本日・作業者・作業記録の抜粋・アイコン・休館日）
  function renderCalendar() {
    return (
      <div className="report-calendar">
        <div className="report-calendar-head">
          {WEEKDAY_HEADERS.map((label, i) => (
            <div
              key={label}
              className={`report-calendar-head-cell${i === 0 ? ' is-sunday' : i === 6 ? ' is-saturday' : ''}`}
            >
              {label}
            </div>
          ))}
        </div>
        {weeks.map((week) => (
          <div className="report-calendar-week" key={week.find(Boolean)}>
            {week.map((date, i) => {
              if (!date) return <div className="report-calendar-cell is-blank" key={`blank-${i}`} />

              const st = dayState(date)
              const { report: r, closed, isToday, weekday: wd, entries, clickable } = st
              const cellClass = [
                'report-calendar-cell',
                closed && 'is-closed',
                isToday && 'is-today',
                (clickable || r) && 'is-clickable',
              ]
                .filter(Boolean)
                .join(' ')
              const onOpen = r ? () => navigate(`/reports/${date}`) : clickable ? () => handleCreateAndOpen(date) : undefined

              return (
                <div
                  className={cellClass}
                  key={date}
                  onClick={onOpen}
                  role={onOpen ? 'button' : undefined}
                  tabIndex={onOpen ? 0 : undefined}
                  aria-disabled={clickable ? creating : undefined}
                  onKeyDown={
                    onOpen
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            onOpen()
                          }
                        }
                      : undefined
                  }
                >
                  <div className="report-calendar-cell-head">
                    <span className={`report-calendar-day ${wd.className}`}>{Number(date.slice(-2))}</span>
                    {isToday && <span className="report-today-badge">本日</span>}
                    {closed && <span className="report-calendar-closed-label">休館日</span>}
                    {r && renderIcons(date, st, 18)}
                  </div>

                  {r ? (
                    <>
                      <div className="report-calendar-workers">
                        {r.worker_am || '—'} | {r.worker_pm || '—'}
                      </div>
                      <div className="report-calendar-body">
                        {entries.length === 0 ? (
                          <span className="report-empty">記録なし</span>
                        ) : (
                          <>
                            {entries.slice(0, CALENDAR_PREVIEW_LINES).map((e) => (
                              <div className="report-calendar-line" key={e.id}>
                                <span className="report-line-time">{toHHMM(e.entry_time)}</span>
                                <span className="report-line-text">{e.content}</span>
                              </div>
                            ))}
                            {entries.length > CALENDAR_PREVIEW_LINES && (
                              <div className="report-more">ほか {entries.length - CALENDAR_PREVIEW_LINES} 件</div>
                            )}
                          </>
                        )}
                      </div>
                    </>
                  ) : (
                    !closed && <div className="report-calendar-empty">未入力</div>
                  )}

                  {!r && renderClosedDayButton(date, st, 'report-calendar-closed-btn')}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="reports-page">
      <AppHeader />
      <div className={`reports-container${activeView === 'calendar' ? ' is-calendar' : ''}`}>
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
            {/* 表示切替（リスト型／カレンダー型）。カレンダー型はマス目が狭くなりすぎるため
                PC/iPad幅でのみ選べるようにし、スマートフォン幅では切替自体を出さない（2026-08-07） */}
            {isWideScreen && (
              <div className="report-view-switch" role="group" aria-label="表示の切り替え">
                <button
                  type="button"
                  className={`report-view-btn${view === 'list' ? ' is-active' : ''}`}
                  aria-pressed={view === 'list'}
                  onClick={() => setView('list')}
                >
                  <IconList size={18} />
                  リスト
                </button>
                <button
                  type="button"
                  className={`report-view-btn${view === 'calendar' ? ' is-active' : ''}`}
                  aria-pressed={view === 'calendar'}
                  onClick={() => setView('calendar')}
                >
                  <IconCalendar size={18} />
                  カレンダー
                </button>
              </div>
            )}
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
        ) : activeView === 'calendar' ? (
          renderCalendar()
        ) : (
          renderList()
        )}
      </div>
    </div>
  )
}
