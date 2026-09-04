import { useCallback, useEffect, useMemo, useState } from 'react'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import WasteScanModal from '../components/WasteScanModal'
import useWasteSheetPdfExport from '../hooks/useWasteSheetPdfExport'
import { IconChevronLeft, IconChevronRight, IconDocument } from '../components/Icons'
import { getCurrentUser, isLimitedRole } from '../lib/auth'
import {
  WASTE_FLOORS,
  classifyWasteWeight,
  currentFiscalYear,
  fiscalYearMonths,
  fetchWasteRecords,
  upsertWasteRecord,
  deleteWasteRecord,
  confirmWasteMonth,
} from '../lib/waste'
import { currentMonthJST, shiftMonth, daysInMonth, weekdayInfo, fetchHolidays } from '../lib/reports'
import './Dashboard.css'
import './Waste.css'

// 廃棄物実測値管理（BKBビル・一般廃棄物。2026-09-03〜）。docs/waste-plan.md 参照。
// 紙の「廃棄物実測集計表」（1ヶ月1枚・日×1〜7階）をそのまま画面の表として再現し、
// セルの直接編集（手入力・訂正）とスキャン取込（Claude Vision）の両方をこの1つの表で
// 受け止める。年度（4月〜翌3月）集計は別ビューとして切り替える。
export default function Waste() {
  const user = getCurrentUser()
  // 書き込みは残留塩素・自主検査と同じ扱い（owner・備品出庫限定ロールは閲覧のみ）
  const readOnly = isLimitedRole(user)

  const [viewMode, setViewMode] = useState('month') // 'month' | 'year'
  const [month, setMonth] = useState(currentMonthJST())
  const [fiscalYear, setFiscalYear] = useState(currentFiscalYear())
  const [records, setRecords] = useState([])
  const [holidays, setHolidays] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [scanOpen, setScanOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const sheetExport = useWasteSheetPdfExport()

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const rows =
        viewMode === 'month' ? await fetchWasteRecords({ month }) : await fetchWasteRecords({ fiscalYear })
      setRecords(rows)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [viewMode, month, fiscalYear])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    fetchHolidays()
      .then(setHolidays)
      .catch(() => setHolidays({}))
  }, [])

  const byKey = useMemo(() => {
    const map = new Map()
    for (const r of records) map.set(`${r.record_date}|${r.floor}`, r)
    return map
  }, [records])

  const days = useMemo(() => {
    if (viewMode !== 'month') return []
    const count = daysInMonth(month)
    return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)
  }, [viewMode, month])

  const unconfirmedCount = useMemo(() => records.filter((r) => !r.is_confirmed).length, [records])

  async function handleSaveCell(recordDate, floor, weightKg) {
    setError('')
    try {
      const saved = await upsertWasteRecord({ record_date: recordDate, floor, weight_kg: weightKg })
      setRecords((prev) => [...prev.filter((r) => !(r.record_date === recordDate && r.floor === floor)), saved])
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleClearCell(record) {
    setError('')
    setRecords((prev) => prev.filter((r) => r.id !== record.id))
    try {
      await deleteWasteRecord(record.id)
    } catch (err) {
      setError(err.message)
      load()
    }
  }

  async function handleConfirmMonth() {
    setConfirming(true)
    setError('')
    try {
      await confirmWasteMonth(month)
      setRecords((prev) => prev.map((r) => ({ ...r, is_confirmed: true })))
      setInfo(`${month.replace('-', '年')}月の実測値を確認済みにしました。`)
    } catch (err) {
      setError(err.message)
    } finally {
      setConfirming(false)
    }
  }

  function handleScanDone(targetMonth, readCount) {
    setScanOpen(false)
    setInfo(
      readCount > 0
        ? `${targetMonth.replace('-', '年')}月分を${readCount}件読み取りました。内容を確認してください。`
        : `${targetMonth.replace('-', '年')}月分は読み取れたマスがありませんでした。画像を確認してください。`
    )
    setViewMode('month')
    setMonth(targetMonth)
  }

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-wide app-scroll">
        <FeatureHeader
          filters={
            <>
              <div className="ui-segmented" role="group" aria-label="表示の切り替え">
                <button
                  type="button"
                  className={`ui-segmented-btn${viewMode === 'month' ? ' is-active' : ''}`}
                  aria-pressed={viewMode === 'month'}
                  onClick={() => setViewMode('month')}
                >
                  月別
                </button>
                <button
                  type="button"
                  className={`ui-segmented-btn${viewMode === 'year' ? ' is-active' : ''}`}
                  aria-pressed={viewMode === 'year'}
                  onClick={() => setViewMode('year')}
                >
                  年度集計
                </button>
              </div>
              {viewMode === 'month' ? (
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
              ) : (
                <div className="inspection-month">
                  <button
                    type="button"
                    className="icon-btn-nav"
                    onClick={() => setFiscalYear((y) => y - 1)}
                    aria-label="前年度"
                    title="前年度"
                  >
                    <IconChevronLeft size={28} />
                  </button>
                  <span className="inspection-month-label">{fiscalYear}年度</span>
                  <button
                    type="button"
                    className="icon-btn-nav"
                    onClick={() => setFiscalYear((y) => y + 1)}
                    aria-label="翌年度"
                    title="翌年度"
                  >
                    <IconChevronRight size={28} />
                  </button>
                </div>
              )}
            </>
          }
          actions={
            viewMode === 'month' && (
              <>
                <button
                  type="button"
                  className="btn-plain"
                  onClick={() => sheetExport.download(month, holidays)}
                  disabled={sheetExport.busy}
                  title="記入用の空欄シートをPDF出力（印刷して手書きの入力用紙として配布）"
                >
                  <IconDocument size={16} />
                  <span className="btn-plain-label">入力シートを印刷</span>
                </button>
                {!readOnly && unconfirmedCount > 0 && (
                  <button type="button" className="btn-plain" onClick={handleConfirmMonth} disabled={confirming}>
                    {confirming ? '確認中…' : `この月を確認済みにする（${unconfirmedCount}）`}
                  </button>
                )}
                {!readOnly && (
                  <button type="button" className="btn-plain" onClick={() => setScanOpen(true)}>
                    <IconDocument size={16} />
                    <span className="btn-plain-label">スキャン取込</span>
                  </button>
                )}
              </>
            )
          }
        />

        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}
        {sheetExport.error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {sheetExport.error}
          </p>
        )}
        {info && <p className="dashboard-banner">{info}</p>}

        {loading ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : viewMode === 'month' ? (
          <MonthTable
            days={days}
            holidays={holidays}
            byKey={byKey}
            readOnly={readOnly}
            onSave={handleSaveCell}
            onClear={handleClearCell}
          />
        ) : (
          <YearTable fiscalYear={fiscalYear} records={records} />
        )}

        <p className="settings-hint waste-legend">
          単位: kg／通常0〜20kg、
          <span className="waste-legend-high">20kg超</span>は多め、
          <span className="waste-legend-extreme">50kg以上</span>
          は書き間違いの疑いがあるため確認してください（自動修正はしません）。
        </p>
      </div>

      {scanOpen && (
        <WasteScanModal defaultMonth={month} onClose={() => setScanOpen(false)} onDone={handleScanDone} />
      )}

      {sheetExport.sheetsPortal}
      {sheetExport.previewModal}
      {sheetExport.busyOverlay}
    </div>
  )
}

function WasteCell({ record, recordDate, floor, readOnly, onSave, onClear }) {
  const [draft, setDraft] = useState(record ? String(record.weight_kg) : '')
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!editing) setDraft(record ? String(record.weight_kg) : '')
  }, [record, editing])

  const level = record ? classifyWasteWeight(record.weight_kg) : 'normal'
  const unconfirmed = Boolean(record && !record.is_confirmed)

  async function commit() {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed === '') {
      if (record) await onClear(record)
      return
    }
    const num = Number(trimmed)
    if (!Number.isFinite(num) || num < 0) {
      setDraft(record ? String(record.weight_kg) : '')
      return
    }
    if (record && num === Number(record.weight_kg)) return
    await onSave(recordDate, floor, num)
  }

  return (
    <input
      type="number"
      inputMode="decimal"
      step="0.1"
      min="0"
      className={`waste-cell-input${level !== 'normal' ? ` is-${level}` : ''}${unconfirmed ? ' is-unconfirmed' : ''}`}
      value={draft}
      disabled={readOnly}
      placeholder="—"
      title={unconfirmed ? '未確認（スキャン取込。内容を確認してください）' : undefined}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      aria-label={`${recordDate} ${floor}階`}
    />
  )
}

function MonthTable({ days, holidays, byKey, readOnly, onSave, onClear }) {
  const colTotals = WASTE_FLOORS.map((floor) =>
    days.reduce((sum, d) => sum + Number(byKey.get(`${d}|${floor}`)?.weight_kg || 0), 0)
  )
  const grandTotal = colTotals.reduce((a, b) => a + b, 0)

  return (
    <div className="ui-table-wrap">
      <table className="ui-table waste-table">
        <thead>
          <tr>
            <th>日</th>
            <th>曜日</th>
            {WASTE_FLOORS.map((f) => (
              <th key={f} className="is-numeric">
                {f}階
              </th>
            ))}
            <th className="is-numeric">合計</th>
          </tr>
        </thead>
        <tbody>
          {days.map((date, i) => {
            const wd = weekdayInfo(date, holidays)
            const rowTotal = WASTE_FLOORS.reduce(
              (sum, f) => sum + Number(byKey.get(`${date}|${f}`)?.weight_kg || 0),
              0
            )
            return (
              <tr key={date}>
                <td className={`waste-day ${wd.className}`}>{i + 1}</td>
                <td className={`waste-day ${wd.className}`}>{wd.label}</td>
                {WASTE_FLOORS.map((floor) => (
                  <td key={floor} className="waste-col-cell">
                    <WasteCell
                      record={byKey.get(`${date}|${floor}`) || null}
                      recordDate={date}
                      floor={floor}
                      readOnly={readOnly}
                      onSave={onSave}
                      onClear={onClear}
                    />
                  </td>
                ))}
                <td className="is-numeric waste-row-total">{rowTotal > 0 ? rowTotal.toFixed(1) : ''}</td>
              </tr>
            )
          })}
          <tr className="waste-total-row">
            <td colSpan={2}>合計</td>
            {colTotals.map((total, i) => (
              <td key={WASTE_FLOORS[i]} className="is-numeric">
                {total > 0 ? total.toFixed(1) : ''}
              </td>
            ))}
            <td className="is-numeric">{grandTotal > 0 ? grandTotal.toFixed(1) : ''}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function YearTable({ fiscalYear, records }) {
  const months = fiscalYearMonths(fiscalYear)
  const sums = useMemo(() => {
    const map = new Map() // 'YYYY-MM|floor' -> total
    for (const r of records) {
      const key = `${r.record_date.slice(0, 7)}|${r.floor}`
      map.set(key, (map.get(key) || 0) + Number(r.weight_kg))
    }
    return map
  }, [records])

  const colTotals = WASTE_FLOORS.map((floor) =>
    months.reduce((sum, m) => sum + (sums.get(`${m}|${floor}`) || 0), 0)
  )
  const grandTotal = colTotals.reduce((a, b) => a + b, 0)

  return (
    <div className="ui-table-wrap">
      <table className="ui-table waste-table">
        <thead>
          <tr>
            <th>月</th>
            {WASTE_FLOORS.map((f) => (
              <th key={f} className="is-numeric">
                {f}階
              </th>
            ))}
            <th className="is-numeric">合計</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => {
            const rowTotal = WASTE_FLOORS.reduce((sum, f) => sum + (sums.get(`${m}|${f}`) || 0), 0)
            return (
              <tr key={m}>
                <td>{Number(m.slice(5, 7))}月</td>
                {WASTE_FLOORS.map((f) => {
                  const v = sums.get(`${m}|${f}`) || 0
                  return (
                    <td key={f} className="is-numeric">
                      {v > 0 ? v.toFixed(1) : ''}
                    </td>
                  )
                })}
                <td className="is-numeric waste-row-total">{rowTotal > 0 ? rowTotal.toFixed(1) : ''}</td>
              </tr>
            )
          })}
          <tr className="waste-total-row">
            <td>{fiscalYear}年度 合計</td>
            {colTotals.map((total, i) => (
              <td key={WASTE_FLOORS[i]} className="is-numeric">
                {total > 0 ? total.toFixed(1) : ''}
              </td>
            ))}
            <td className="is-numeric">{grandTotal > 0 ? grandTotal.toFixed(1) : ''}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
