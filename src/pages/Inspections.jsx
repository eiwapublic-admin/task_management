import { useCallback, useEffect, useMemo, useState } from 'react'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import InspectionForm from '../components/InspectionForm'
import { IconChevronLeft, IconChevronRight } from '../components/Icons'
import { getCurrentUser, isLimitedRole } from '../lib/auth'
import {
  INSPECTION_ITEMS,
  INSPECTION_BUILDINGS,
  JUDGEMENT_MARKS,
  fetchInspections,
  deleteInspection,
  fetchHolidays,
  fetchClosedDays,
  weekdayInfo,
  currentMonthJST,
  shiftMonth,
  daysInMonth,
  todayJST,
} from '../lib/reports'
import './Dashboard.css'

// 自主検査表（日常）。紙の様式の置き換え。
// 紙の記入ルール「不備が有る場合は項目に×とし、良好の場合は確認箇所一斉に○とすること」に
// 合わせ、通常は「すべて良好」1タップで済み、不備のある項目だけ×/◎に落とす。
export default function Inspections() {
  const user = getCurrentUser()
  // 自主検査表の書き込みは owner・備品出庫限定ロール（2026-08-25追加）どちらも不可
  const readOnly = isLimitedRole(user)

  const [month, setMonth] = useState(currentMonthJST())
  // BKBのみ運用のため切替UIは廃止し固定にする（2026-08-05）
  const building = INSPECTION_BUILDINGS[0]
  const [rows, setRows] = useState([])
  // 休館日（closed_days）はプロジェクト共通情報のため、自主検査表の記録とは別に取得する
  const [closedDays, setClosedDays] = useState(new Set())
  const [holidays, setHolidays] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null) // 入力中の日付（'YYYY-MM-DD'）

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [inspections, closed] = await Promise.all([
        fetchInspections({ month }),
        fetchClosedDays({ month }),
      ])
      setRows(inspections)
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

  // 祝日一覧は月に依らず一度だけ取得する（データセット全体が小さいため）。
  // 取得できなくても曜日の色分け（土曜/日曜）自体は機能させる。
  useEffect(() => {
    fetchHolidays()
      .then(setHolidays)
      .catch(() => setHolidays({}))
  }, [])

  // 表示中のビル・月の記録を日付で引けるようにする
  const byDate = useMemo(() => {
    const map = new Map()
    for (const r of rows) {
      if (r.building === building) map.set(r.inspected_on, r)
    }
    return map
  }, [rows, building])

  const days = useMemo(() => {
    const count = daysInMonth(month)
    return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)
  }, [month])

  const today = todayJST()

  // 機能ヘッダの「＋」。表示中の月がずれていると byDate（表示中の月のデータしか
  // 持たない）が当日の既存記録を拾えず、開いたフォームが誤って空欄になる
  // （＝保存すると既存記録を上書きしてしまう）ため、その場合は当月のデータを
  // 取り直してから開く。表示中の月が既に当月ならそのまま開く（多くはこちら）
  async function handleQuickAdd() {
    const cur = currentMonthJST()
    if (month === cur) {
      setEditing(today)
      return
    }
    setMonth(cur)
    try {
      const [inspections, closed] = await Promise.all([
        fetchInspections({ month: cur }),
        fetchClosedDays({ month: cur }),
      ])
      setRows(inspections)
      setClosedDays(new Set(closed))
    } catch (err) {
      setError(err.message)
    }
    setEditing(today)
  }

  function handleSaved(result) {
    if (result.closed) {
      setClosedDays((prev) => new Set(prev).add(result.inspected_on))
      setRows((prev) => prev.filter((r) => r.inspected_on !== result.inspected_on))
    } else {
      setClosedDays((prev) => {
        if (!prev.has(result.inspected_on)) return prev
        const next = new Set(prev)
        next.delete(result.inspected_on)
        return next
      })
      setRows((prev) => {
        const others = prev.filter((r) => r.id !== result.id)
        return [...others, result]
      })
    }
    setEditing(null)
  }

  // 削除（実際の点検記録のみ。休館日はモーダルのスイッチをオフにして保存すると解除される）。
  async function handleDelete(id) {
    setRows((prev) => prev.filter((r) => r.id !== id))
    try {
      await deleteInspection(id)
    } catch (err) {
      setError(err.message)
      load()
    }
    setEditing(null)
  }

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-wide app-scroll">
        {/* 機能ヘッダ（2026-08-13）。ホームボタンは廃止（機能間の移動はダッシュボード経由に
            一本化済み）。年月・＋（当日を記録）・↓（PDF出力）をこの順で1行に収めるため、
            すべて filters（左側）に入れる（actions を使うと狭幅で2行目に分かれてしまうため） */}
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
              {!readOnly && (
                <button
                  type="button"
                  className="icon-btn-add"
                  onClick={handleQuickAdd}
                  aria-label="本日の自主検査を記録"
                  title="本日の自主検査を記録"
                >
                  ＋
                </button>
              )}
            </>
          }
        />

        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : (
          <div className="inspection-table-wrap">
            <table className="inspection-table">
              <thead>
                <tr>
                  <th>日</th>
                  <th>点検者</th>
                  <th>結果</th>
                  <th>不備の内容</th>
                </tr>
              </thead>
              <tbody>
                {days.map((date) => {
                  const rec = byDate.get(date)
                  const day = Number(date.slice(-2))
                  const ngKeys = rec ? Object.keys(rec.items || {}) : []
                  const isFuture = date > today
                  const closed = closedDays.has(date)
                  const wd = weekdayInfo(date, holidays)
                  // 未入力/既存どちらも行全体のタップで詳細モーダルを開く（追加と変更を区別しない）。
                  // 未来日でも休館日の指定はできるようにタップ可能にする（2026-09-01）
                  const clickable = !readOnly
                  const rowClass = [
                    date === today && 'is-today',
                    closed && 'is-closed',
                    clickable && 'is-clickable',
                  ]
                    .filter(Boolean)
                    .join(' ')
                  return (
                    <tr
                      key={date}
                      className={rowClass || undefined}
                      onClick={clickable ? () => setEditing(date) : undefined}
                      role={clickable ? 'button' : undefined}
                      tabIndex={clickable ? 0 : undefined}
                      onKeyDown={
                        clickable
                          ? (e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                setEditing(date)
                              }
                            }
                          : undefined
                      }
                    >
                      <th
                        scope="row"
                        className={`inspection-day ${wd.className}`}
                        title={wd.holidayName || undefined}
                      >
                        {day}
                        <span className="inspection-weekday">({wd.label})</span>
                        {date === today && <span className="report-today-badge">本日</span>}
                      </th>
                      <td>{closed ? '—' : rec?.inspector || (rec ? '—' : '')}</td>
                      <td>
                        {closed ? (
                          <span className="inspection-closed-label">休館日</span>
                        ) : !rec ? (
                          <span className="inspection-empty">
                            {isFuture ? '' : clickable ? '未入力（タップで記録）' : '未実施'}
                          </span>
                        ) : rec.all_clear ? (
                          <span className="inspection-ok">○ 異常なし</span>
                        ) : (
                          <span className="inspection-ng">{ngKeys.length} 件の不備</span>
                        )}
                      </td>
                      <td className="inspection-issues">
                        {!closed && rec && ngKeys.length > 0 && (
                          <span>
                            {ngKeys
                              .map((k) => {
                                const item = INSPECTION_ITEMS.find((i) => i.key === k)
                                return `${item?.label || k}${JUDGEMENT_MARKS[rec.items[k]]}`
                              })
                              .join('、')}
                          </span>
                        )}
                        {!closed && rec?.note && <span className="inspection-note">{rec.note}</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="settings-hint inspection-legend">
          凡例: ○ 良／× 不良／◎ 即時改修　　不備・欠陥がある場合は直ちに防火管理者に報告してください。
        </p>
      </div>

      {editing && (
        <InspectionForm
          date={editing}
          building={building}
          existing={byDate.get(editing) || null}
          initialClosed={closedDays.has(editing)}
          isSundayOrHoliday={weekdayInfo(editing, holidays).isRed}
          defaultInspector={user?.display_name || ''}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
          onDelete={handleDelete}
        />
      )}
    </div>
  )
}
