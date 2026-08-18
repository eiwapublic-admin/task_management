import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import ReportDetail from './ReportDetail'
import FeatureHeader from '../components/FeatureHeader'
import InspectionForm from '../components/InspectionForm'
import {
  IconCar,
  IconClip,
  IconCheckCircle,
  IconChevronLeft,
  IconChevronRight,
  IconList,
  IconCalendar,
  IconSearch,
  IconDroplet,
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
  deleteInspection,
  INSPECTION_BUILDINGS,
  weekdayInfo,
  currentMonthJST,
  shiftMonth,
  daysInMonth,
  sortEntriesByTime,
} from '../lib/reports'
import './Dashboard.css'
// AttachmentPreview（PDFのアプリ内プレビュー）の見た目は本来タスク管理側の
// KanbanBoard.css で定義されており、日報一覧を直接開いた場合はまだ読み込まれて
// いないことがあるため、ここでも明示的に import しておく（Inspections.jsxと同じ対応）。
import '../components/KanbanBoard.css'

// 作業記録は件数で打ち切らず全件出す（2026-08-07。従来は3件までで「ほか N 件」と
// 省略していたが、枠の高さを伸縮させて全部見えるようにしてほしいとの要望による）。
// リスト型・カレンダー型とも、行／マス目の高さは中身に合わせて伸びる。

// カレンダー型を出せる下限幅（iPad縦=768pxを含める）。これ未満（＝スマートフォン）は
// マス目が狭すぎて実用にならないため、リスト型のみとする
const WIDE_SCREEN_QUERY = '(min-width: 768px)'

const WEEKDAY_HEADERS = ['日', '月', '火', '水', '木', '金', '土']

// リスト/カレンダーの選択を覚えておくキー（2026-08-07）。違反車両一覧・自主検査表など
// 他画面のホームボタンで /reports に戻ると ReportList は作り直されて view state が
// 初期値に戻ってしまうため、sessionStorage に退避してタブを閉じるまで保持する
// （ログイン情報等ではないため localStorage ほど長く残す必要はない）。
const VIEW_STORAGE_KEY = 'reports_view'

// 正規表現の特殊文字をエスケープする（検索語をそのままRegExpに渡すため）
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 作業記録のテキスト中の一致箇所を <mark> で強調する
function highlightMatch(text, query) {
  if (!query) return text
  const parts = text.split(new RegExp(`(${escapeRegExp(query)})`, 'ig'))
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase() ? (
      <mark className="report-search-hit" key={i}>
        {part}
      </mark>
    ) : (
      part
    ),
  )
}

// 自主検査表（Inspections.jsx）と同じ「月単位・＜＞で移動・1日から全日表示」の構成にする
// （2026-08-07）。休館日はプロジェクト共通情報（closed_days）のため自主検査表とも共有する。
// 表示は「リスト型」と「カレンダー型」を切り替えられる（カレンダー型はPC/iPad専用。2026-08-07）。
export default function ReportList() {
  const navigate = useNavigate()
  // URLが /reports/:date のときは、その日の詳細を一覧の上にモーダルで重ねる（2026-08-07）。
  // 別画面にしないことで一覧の月・表示形式（リスト/カレンダー）がそのまま残り、
  // 閉じたときに元の見え方へ戻る。
  const { date: openDate } = useParams()
  const user = getCurrentUser()
  const isOwner = user?.role === 'owner'

  const [month, setMonth] = useState(currentMonthJST())
  const [reports, setReports] = useState([])
  const [closedDays, setClosedDays] = useState(new Set())
  // 自主点検の実施記録（表示中の月分）。日付だけでなく既存レコードそのものを保持し、
  // チェックマークアイコンから開く入力ウインドウの「既存記録の編集」に使う（2026-08-18）
  const [inspections, setInspections] = useState([])
  const [holidays, setHolidays] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 未入力の行タップで新規作成中（多重タップ防止）
  const [creating, setCreating] = useState(false)
  // チェックマークアイコンから開く自主点検の入力ウインドウ。開いている日付（'YYYY-MM-DD'）を保持
  const [editingInspection, setEditingInspection] = useState(null)
  // 'list' | 'calendar'
  const [view, setView] = useState(() =>
    typeof window !== 'undefined' && sessionStorage.getItem(VIEW_STORAGE_KEY) === 'calendar'
      ? 'calendar'
      : 'list',
  )
  // 作業記録の検索（2026-08-08）。虫眼鏡タップで検索欄を開閉し、入力文字が
  // 1文字でもあれば通常のリスト/カレンダー表示に代えて検索結果を出す。
  // 対象は日報全般（表示中の月に限らず、一覧が既に保持している全期間分の
  // reportsから探す。/api/reports は元々全期間を一度に取得している）。
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searching = searchQuery.trim().length > 0
  // カレンダー型を出せる画面幅か。回転（iPadの縦横）にも追従させる
  const [isWideScreen, setIsWideScreen] = useState(
    () => typeof window === 'undefined' || window.matchMedia(WIDE_SCREEN_QUERY).matches,
  )
  // 機能ヘッダ（＋開いていれば検索欄）を AppHeader の下に固定表示する2段目は
  // FeatureHeader が受け持つ（高さの実測も含む。2026-08-12）。カレンダー型の曜日行は
  // さらにその下の3段目として重ねる（.report-calendar-head の .ui-sticky-head-2。renderCalendar 内）

  useEffect(() => {
    if (typeof window !== 'undefined') sessionStorage.setItem(VIEW_STORAGE_KEY, view)
  }, [view])

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
      const [list, closed, inspectionList] = await Promise.all([
        fetchReports(),
        fetchClosedDays({ month }),
        fetchInspections({ month }),
      ])
      setReports(list)
      setClosedDays(new Set(closed))
      setInspections(inspectionList)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [month])

  // 表示中の月の自主点検レコードを日付で引けるようにする（チェックマークの状態判定・
  // 入力ウインドウへ渡す既存レコードの両方で使う）
  const inspectionsByDate = useMemo(() => {
    const map = new Map()
    for (const i of inspections) if (i.building === building) map.set(i.inspected_on, i)
    return map
  }, [inspections, building])

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

  // 一覧・カレンダーのチェックマークアイコンから自主点検の入力ウインドウを開く（2026-08-18）
  function handleInspectionSaved(result) {
    if (result.closed) {
      setClosedDays((prev) => new Set(prev).add(result.inspected_on))
      setInspections((prev) => prev.filter((i) => i.inspected_on !== result.inspected_on))
    } else {
      setClosedDays((prev) => {
        if (!prev.has(result.inspected_on)) return prev
        const next = new Set(prev)
        next.delete(result.inspected_on)
        return next
      })
      setInspections((prev) => [...prev.filter((i) => i.id !== result.id), result])
    }
    setEditingInspection(null)
  }

  async function handleInspectionDelete(id) {
    setInspections((prev) => prev.filter((i) => i.id !== id))
    try {
      await deleteInspection(id)
    } catch (err) {
      setError(err.message)
      load()
    }
    setEditingInspection(null)
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
      // 詳細画面と同じ時刻順で出す（APIはsort_order順で返すため、ここで並べ替える）
      entries: r ? sortEntriesByTime((r.entries || []).filter((e) => e.content)) : [],
      // 未入力かつ未来日でなければタップで新規作成できる
      clickable: !r && !isOwner && !closed && !isFuture,
    }
  }

  // 右端のアイコン4種を2段に分けて表示する（2026-08-10。1段では窮屈になったため）。
  // 上段＝添付画像・自主点検、下段＝違反車両・残留塩素。該当しないものは場所だけ残して
  // 非表示にする（2026-08-05〜）。自主点検は当日以前で未実施のときだけ黄色い丸で目立たせる。
  // リスト型・カレンダー型・検索結果で共通して使う。
  // 自主点検アイコンは押すとその日の入力ウインドウを開く（2026-08-18）。行・マス自体も
  // タップ領域を持つため、伝播を止めて行のクリック（詳細を開く）と衝突しないようにする。
  // 表示専用のowner（読み取り専用ロール）には従来どおりの非活性な丸のまま出す。
  function renderIconsRow1(date, { report, isFuture }, size) {
    const done = inspectionsByDate.has(date)
    const badgeClass = `report-row-icon report-inspection-icon${done ? ' is-done' : !isFuture ? ' is-pending' : ''}`
    return (
      <div className="report-row-icons">
        <span className={`report-row-icon${report?.has_photos ? '' : ' is-hidden'}`} title="添付画像あり">
          <IconClip size={size} />
        </span>
        {isOwner ? (
          <span className={badgeClass} title={done ? '自主点検実施済み' : '自主点検未実施'}>
            <IconCheckCircle size={size - 2} />
          </span>
        ) : (
          <button
            type="button"
            className={badgeClass}
            title={done ? '自主点検実施済み（タップで確認・修正）' : '自主点検未実施（タップで記録）'}
            aria-label={done ? '自主点検を確認・修正する' : '自主点検を記録する'}
            onClick={(e) => {
              e.stopPropagation()
              setEditingInspection(date)
            }}
          >
            <IconCheckCircle size={size - 2} />
          </button>
        )}
      </div>
    )
  }

  function renderIconsRow2(_date, { report }, size) {
    return (
      <div className="report-row-icons">
        <span className={`report-row-icon${report?.has_parking ? '' : ' is-hidden'}`} title="違反車両あり">
          <IconCar size={size} />
        </span>
        <span className={`report-row-icon${report?.has_chlorine ? '' : ' is-hidden'}`} title="残留塩素の測定あり">
          <IconDroplet size={size} />
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
            // チェックマークアイコン（自主点検入力への入口）を行内に持たせるため、
            // 行自体は<button>ではなくrole="button"の<div>にする（2026-08-18。
            // <button>の中に<button>は入れられないため）
            return (
              <li key={date}>
                <div
                  className={`report-row${isToday ? ' is-today' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/reports/${date}`)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      navigate(`/reports/${date}`)
                    }
                  }}
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
                        entries.map((e) => (
                          <div className="report-line" key={e.id}>
                            <span className="report-line-time">{toHHMM(e.entry_time)}</span>
                            <span className="report-line-text">{e.content}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                  <div className="report-row-icons-stack">
                    {renderIconsRow1(date, st, 20)}
                    {renderIconsRow2(date, st, 20)}
                  </div>
                </div>
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
        {/* 縦スクロールしてもツールバーの下に重ねて固定表示する（2026-08-11） */}
        <div className="report-calendar-head ui-sticky-head-2">
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
                    {r && renderIconsRow1(date, st, 18)}
                  </div>

                  {r ? (
                    <>
                      <div className="report-calendar-workers-row">
                        <span className="report-calendar-workers">
                          {r.worker_am || '—'} | {r.worker_pm || '—'}
                        </span>
                        {renderIconsRow2(date, st, 18)}
                      </div>
                      <div className="report-calendar-body">
                        {entries.length === 0 ? (
                          <span className="report-empty">記録なし</span>
                        ) : (
                          entries.map((e) => (
                            <div className="report-calendar-line" key={e.id}>
                              <span className="report-line-time">{toHHMM(e.entry_time)}</span>
                              <span className="report-line-text">{e.content}</span>
                            </div>
                          ))
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

  function handleToggleSearch() {
    if (searchOpen) {
      setSearchOpen(false)
      setSearchQuery('')
    } else {
      setSearchOpen(true)
    }
  }

  // 検索結果。表示中の月に関わらず、一覧が保持している全期間分のreportsから
  // 作業記録のテキスト内容（entries[].content）に一致するものを探す。
  // マッチした明細だけを、日付の新しい順（reportsの取得順のまま）に出す。
  function renderSearchResults() {
    const q = searchQuery.trim().toLowerCase()
    const matches = reports
      .map((r) => ({
        report: r,
        entries: sortEntriesByTime((r.entries || []).filter((e) => e.content)).filter((e) =>
          e.content.toLowerCase().includes(q),
        ),
      }))
      .filter((m) => m.entries.length > 0)

    if (matches.length === 0) {
      return <p className="report-empty">「{searchQuery}」に一致する作業記録は見つかりませんでした。</p>
    }

    return (
      <ul className="report-list">
        {matches.map(({ report: r, entries }) => {
          const wd = weekdayInfo(r.report_date, holidays)
          return (
            <li key={r.report_date}>
              <div
                className="report-row"
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/reports/${r.report_date}`)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    navigate(`/reports/${r.report_date}`)
                  }
                }}
              >
                <div className="report-row-main">
                  <div className="report-row-date">
                    <span className={`report-date ${wd.className}`}>{formatReportDate(r.report_date)}</span>
                    <span className="report-workers">
                      {r.worker_am || '—'} | {r.worker_pm || '—'}
                    </span>
                  </div>
                  <div className="report-row-body">
                    {entries.map((e) => (
                      <div className="report-line" key={e.id}>
                        <span className="report-line-time">{toHHMM(e.entry_time)}</span>
                        <span className="report-line-text">{highlightMatch(e.content, searchQuery.trim())}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="report-row-icons-stack">
                  {renderIconsRow1(r.report_date, dayState(r.report_date), 20)}
                  {renderIconsRow2(r.report_date, dayState(r.report_date), 20)}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <div className="ui-page">
      <AppHeader />
      {/* 検索結果表示中は（カレンダー型であっても）リスト型と同じ900px幅に戻す。
          検索結果はリスト型の行レイアウトを再利用しているため（2026-08-08） */}
      <div className={`ui-container reports-container${activeView === 'calendar' && !searching ? ' is-calendar' : ' is-narrow'}`}>
        {/* 機能ヘッダ（AppHeader の下に固定表示）。機能名「日報」はアプリヘッダの
            タイトルが示すので、ここではタイトルを置かない（2026-08-12）。
            左＝年月の移動・表示切替・検索、右＝機能ボタン。開閉する検索欄は
            children としてこのヘッダーに追従させる */}
        <FeatureHeader
          filters={
            <>
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
              {/* 表示切替（リスト型／カレンダー型）。カレンダー型はマス目が狭くなりすぎるため
                  PC/iPad幅でのみ選べるようにし、スマートフォン幅では切替自体を出さない（2026-08-07） */}
              {isWideScreen && (
                <div className="ui-segmented" role="group" aria-label="表示の切り替え">
                  <button
                    type="button"
                    className={`ui-segmented-btn${view === 'list' ? ' is-active' : ''}`}
                    aria-pressed={view === 'list'}
                    onClick={() => setView('list')}
                  >
                    <IconList size={18} />
                    リスト
                  </button>
                  <button
                    type="button"
                    className={`ui-segmented-btn${view === 'calendar' ? ' is-active' : ''}`}
                    aria-pressed={view === 'calendar'}
                    onClick={() => setView('calendar')}
                  >
                    <IconCalendar size={18} />
                    カレンダー
                  </button>
                </div>
              )}
              {/* 作業記録の検索（2026-08-08）。押すと下に検索欄が開く。絞り込みの操作なので
                  機能ボタン側ではなく左側（表示条件のグループ）に置く（2026-08-12） */}
              <button
                type="button"
                className={`icon-btn-search${searchOpen ? ' is-active' : ''}`}
                onClick={handleToggleSearch}
                aria-label="作業記録を検索"
                aria-pressed={searchOpen}
                title="作業記録を検索"
              >
                <IconSearch size={20} />
              </button>
            </>
          }
        >
          {searchOpen && (
            <div className="reports-search-bar">
              <IconSearch size={18} />
              <input
                type="search"
                className="reports-search-input"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="作業記録を検索"
                aria-label="作業記録を検索"
                autoFocus
              />
              {searchQuery && (
                <button
                  type="button"
                  className="reports-search-clear"
                  onClick={() => setSearchQuery('')}
                  aria-label="検索文字をクリア"
                >
                  ×
                </button>
              )}
            </div>
          )}
        </FeatureHeader>

        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : searching ? (
          renderSearchResults()
        ) : activeView === 'calendar' ? (
          renderCalendar()
        ) : (
          renderList()
        )}
      </div>

      {/* 日報詳細（一覧の上に重ねるモーダル）。閉じたら一覧のURLへ戻し、
          モーダル内での編集・削除・休館日指定を一覧へ反映するため読み直す */}
      {openDate && (
        <ReportDetail
          key={openDate}
          date={openDate}
          onClose={() => {
            navigate('/reports')
            load()
          }}
        />
      )}

      {/* 一覧・カレンダーのチェックマークアイコンから開く自主点検の入力ウインドウ（2026-08-18） */}
      {editingInspection && (
        <InspectionForm
          date={editingInspection}
          building={building}
          existing={inspectionsByDate.get(editingInspection) || null}
          initialClosed={closedDays.has(editingInspection)}
          defaultInspector={user?.display_name || ''}
          onClose={() => setEditingInspection(null)}
          onSaved={handleInspectionSaved}
          onDelete={handleInspectionDelete}
        />
      )}
    </div>
  )
}
