import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import InspectionForm from '../components/InspectionForm'
import InspectionSheet from '../components/InspectionSheet'
import { IconHome, IconChevronLeft, IconChevronRight, IconDownload } from '../components/Icons'
import { getCurrentUser } from '../lib/auth'
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
  halfMonthRanges,
  todayJST,
} from '../lib/reports'
import './Dashboard.css'

// 自主検査表（日常）。紙の様式の置き換え。
// 紙の記入ルール「不備が有る場合は項目に×とし、良好の場合は確認箇所一斉に○とすること」に
// 合わせ、通常は「すべて良好」1タップで済み、不備のある項目だけ×/◎に落とす。
export default function Inspections() {
  const navigate = useNavigate()
  const user = getCurrentUser()
  const readOnly = user?.role === 'owner'

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
  const [pdfBusy, setPdfBusy] = useState(false)
  const [pdfError, setPdfError] = useState('')
  // PDF化のときだけ画面外に描画する紙様式のシート（前半・後半の2枚）を差し込む場所
  const sheetsRef = useRef(null)

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

  // 紙の様式は「実施日時」が16列しかないため、PDFは半月ごとに1ページとする
  const ranges = useMemo(() => halfMonthRanges(month, daysInMonth(month)), [month])

  // 定期点検（6月・12月）と防火管理者確認は月に1つの欄しかないため、その月の記録から拾う
  const monthRecords = useMemo(() => rows.filter((r) => r.building === building), [rows, building])
  const periodicResult = useMemo(
    () => monthRecords.find((r) => r.periodic_result)?.periodic_result || '',
    [monthRecords],
  )
  const confirmedBy = useMemo(
    () => monthRecords.find((r) => r.confirmed_by)?.confirmed_by || '',
    [monthRecords],
  )

  // 画面外に置いた紙様式のシートを html2canvas で撮り、1枚＝1ページのPDFにする。
  // シートは 210×297mm ちょうどで組んであるので addImage の固定配置で必ず1ページに収まる
  // （プロジェクトスキル print-and-pdf-download を参照。iOSのホーム画面アプリでは
  // window.print() が無反応のため、印刷ではなくPDFダウンロードで出力する）。
  async function handleDownloadPdf() {
    if (!sheetsRef.current) return
    setPdfBusy(true)
    setPdfError('')
    try {
      // 手書きCSS（hex色・mm指定）のみのシートなので html2canvas-pro ではなく本家を使う
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import('html2canvas'),
        import('jspdf'),
      ])

      document.body.classList.add('pdf-capture-mode')
      try {
        // クラス適用後のレイアウトが確定してから撮る
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

        const sheets = sheetsRef.current.querySelectorAll('.ins-sheet')
        const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
        for (const [i, sheet] of [...sheets].entries()) {
          const canvas = await html2canvas(sheet, { scale: 3, backgroundColor: '#ffffff' })
          if (i > 0) pdf.addPage()
          // 第8引数の圧縮指定（'FAST'）は必須。既定の無圧縮だとA4・scale3の画像が
          // 生データのまま埋め込まれ、2ページで約48MBになる（'FAST'で約0.9MB。
          // 可逆圧縮なので線や文字の劣化はない）。
          pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, 210, 297, undefined, 'FAST')
        }
        pdf.save(`自主検査表_${building}_${month}.pdf`)
      } finally {
        // ここを外し忘れるとシートが画面外に出たままになるため必ず finally で戻す
        document.body.classList.remove('pdf-capture-mode')
      }
    } catch (err) {
      // 失敗の原因（描画できない色・レイアウト等）はこのメッセージにしか出ないため握り潰さない
      setPdfError(`PDFの作成に失敗しました（${err instanceof Error ? err.message : String(err)}）`)
    } finally {
      setPdfBusy(false)
    }
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
    <div className="reports-page">
      <AppHeader />
      <div className="reports-container inspections-container">
        <div className="reports-toolbar inspection-toolbar">
          <button
            type="button"
            className="icon-btn-home"
            onClick={() => navigate('/reports')}
            aria-label="日報一覧に戻る"
            title="日報一覧に戻る"
          >
            <IconHome size={32} />
          </button>
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
          <h2 className="page-title">自主検査表（日常）</h2>
          <button
            type="button"
            className="btn-plain inspection-pdf-btn"
            onClick={handleDownloadPdf}
            disabled={pdfBusy || loading}
            title="紙の様式でPDFに出力する（半月ごとに1ページ）"
          >
            <IconDownload size={18} />
            {pdfBusy ? '作成中…' : 'PDF'}
          </button>
        </div>

        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}

        {pdfError && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {pdfError}
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
                  // 未来日はまだ記録できないので、既に何かある場合を除きタップ不可にする
                  const clickable = !readOnly && (Boolean(rec) || closed || !isFuture)
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

      {/* PDF用の紙様式シート。通常は display:none で、PDF作成中だけ画面外に描画される。
          親のレイアウト（flex/overflow）の影響を受けないよう body 直下に出す。 */}
      {createPortal(
        <div ref={sheetsRef}>
          {ranges.map((range) => (
            <InspectionSheet
              key={range.from}
              building={building}
              month={month}
              range={range}
              byDate={byDate}
              closedDays={closedDays}
              holidays={holidays}
              periodicResult={periodicResult}
              confirmedBy={confirmedBy}
            />
          ))}
        </div>,
        document.body,
      )}

      {editing && (
        <InspectionForm
          date={editing}
          building={building}
          existing={byDate.get(editing) || null}
          initialClosed={closedDays.has(editing)}
          defaultInspector={user?.display_name || ''}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
          onDelete={handleDelete}
        />
      )}
    </div>
  )
}
