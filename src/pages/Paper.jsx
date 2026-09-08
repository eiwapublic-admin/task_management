import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import { IconChevronLeft, IconChevronRight } from '../components/Icons'
import { getCurrentUser, isLimitedRole } from '../lib/auth'
import {
  PAPER_CATEGORIES,
  collectDatesOfFiscalYear,
  currentFiscalYear,
  deletePaperRecord,
  fetchPaperRecords,
  fiscalYearOf,
  formatKg,
  paperRowTotal,
  upsertPaperRecord,
} from '../lib/paper'
import { fetchHolidays, fetchClosedDays, todayJST, weekdayInfo } from '../lib/reports'
import './Dashboard.css'
import './Paper.css'

// 古紙回収量の記録（備後町コイズミビル＝BKB。2026-09-08〜）。
// 従来のExcel「月別古紙回収量一覧表」（年度ごとのシート・毎週月曜の行・段ボール／
// シュレッダ／雑誌／その他の4区分）をそのまま画面に移したもの。回収予定日はDBに持たず
// 年度内の月曜を自動生成し、入力のあった回だけをDBへ保存する（src/lib/paper.js）。
// 祝日・休館日に当たった週は「中止」にでき、日程がずれた週は回収予定日そのものを
// 直接書き換える（2026-09-09。備考欄は自由記入の備考専用）。
export default function Paper() {
  const user = getCurrentUser()
  // 書き込みは廃棄物・残留塩素と同じ扱い（owner・備品出庫限定ロールは閲覧のみ）
  const readOnly = isLimitedRole(user)

  const [fiscalYear, setFiscalYear] = useState(currentFiscalYear())
  const [records, setRecords] = useState([])
  const [holidays, setHolidays] = useState({})
  const [closedDays, setClosedDays] = useState(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setRecords(await fetchPaperRecords(fiscalYear))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [fiscalYear])

  useEffect(() => {
    load()
  }, [load])

  // 祝日・休館日は「その週が中止になりやすい日」の目印として出す（取得できなくても
  // 一覧自体は表示する。自主検査表・日報一覧と同じ共通データ）
  useEffect(() => {
    fetchHolidays()
      .then(setHolidays)
      .catch(() => setHolidays({}))
    fetchClosedDays()
      .then((days) => setClosedDays(new Set(days || [])))
      .catch(() => setClosedDays(new Set()))
  }, [])

  const byDate = useMemo(() => {
    const map = new Map()
    for (const r of records) map.set(r.collect_date, r)
    return map
  }, [records])

  // 画面に出す行＝年度内の回収予定日（毎週月曜）。日程変更で月曜以外に回収した回が
  // DBにあれば、その日付も行として差し込む（予定日から外れた記録を隠さないため）
  const rows = useMemo(() => {
    const dates = new Set(collectDatesOfFiscalYear(fiscalYear))
    for (const r of records) dates.add(r.collect_date)
    return [...dates].sort()
  }, [fiscalYear, records])

  // 「本日」の行＝本日、または本日に一番近い過去の回収予定日（回収は週1回なので、
  // 水曜に開いたときは直前の月曜＝その週の回収日を指す）。今年度を見ているときだけ出す
  const today = todayJST()
  const todayDate = useMemo(() => {
    if (fiscalYear !== currentFiscalYear()) return ''
    let found = ''
    for (const date of rows) {
      if (date > today) break
      found = date
    }
    return found
  }, [rows, today, fiscalYear])

  // 「本日」ボタン（日報一覧と同じ流儀）。他年度を見ているときは今年度へ切り替えてから
  // スクロールする必要があるため、切替後の再読み込みの完了を待つ
  const scrollToTodayRef = useRef(false)

  function scrollToToday() {
    requestAnimationFrame(() => {
      document.querySelector('.paper-row.is-today')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }

  function handleGoToToday() {
    if (fiscalYear === currentFiscalYear()) {
      scrollToToday()
    } else {
      scrollToTodayRef.current = true
      setFiscalYear(currentFiscalYear())
    }
  }

  useEffect(() => {
    if (!loading && scrollToTodayRef.current) {
      scrollToTodayRef.current = false
      scrollToToday()
    }
  }, [loading])

  // 月ごとにまとめる（Excelの「年月」列＋右側の月別集計に相当）
  const months = useMemo(() => {
    const map = new Map() // 'YYYY-MM' -> { month, dates[], total }
    for (const date of rows) {
      const key = date.slice(0, 7)
      if (!map.has(key)) map.set(key, { month: key, dates: [], total: 0 })
      const group = map.get(key)
      group.dates.push(date)
      group.total += paperRowTotal(byDate.get(date))
    }
    return [...map.values()]
  }, [rows, byDate])

  // 年度合計と月平均。平均は「実績のある月」だけで割る（Excelが未到来の月を
  // #N/A にして平均・近似曲線から外しているのと同じ考え方）
  const summary = useMemo(() => {
    const withData = months.filter((m) => m.total > 0)
    const total = withData.reduce((sum, m) => sum + m.total, 0)
    return {
      total,
      average: withData.length > 0 ? total / withData.length : 0,
      monthCount: withData.length,
    }
  }, [months])

  async function handleSave(collectDate, patch) {
    setError('')
    const current = byDate.get(collectDate) || {}
    const payload = {
      collect_date: collectDate,
      skipped: current.skipped || false,
      note: current.note || '',
      ...Object.fromEntries(PAPER_CATEGORIES.map((c) => [c.key, current[c.key] ?? ''])),
      ...patch,
    }
    // 楽観的に反映してから保存する（週の入力を続けて打てるようにするため）
    setRecords((prev) => [...prev.filter((r) => r.collect_date !== collectDate), { ...current, ...payload }])
    try {
      const saved = await upsertPaperRecord(payload)
      setRecords((prev) => [...prev.filter((r) => r.collect_date !== collectDate), saved])
    } catch (err) {
      setError(err.message)
      load()
    }
  }

  // 回収予定日そのものを直接書き換える（2026-09-09。依頼。祝日・休館日で日がずれた週を
  // 備考への自由記入ではなく、実際にその週の行を目的の日付へ動かす形にした）。
  // 元の日付に記録（重量・中止・備考）があれば、その内容を新しい日付へ移し、
  // 元の行は削除する（回収予定日はDBに持たないため、移動元は自動生成の空行に戻る）
  async function handleDateChange(oldDate, newDate) {
    if (!newDate || newDate === oldDate || !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) return
    setError('')
    if (fiscalYearOf(newDate.slice(0, 7)) !== fiscalYear) {
      setError('表示中の年度をまたぐ日付には変更できません。まずその年度に切り替えてください。')
      return
    }
    const current = byDate.get(oldDate)
    const target = byDate.get(newDate)
    if (target && (target.skipped || target.note || PAPER_CATEGORIES.some((c) => target[c.key] != null))) {
      setError(`${newDate.replace(/-/g, '/')} には既に記録があるため、その日付には変更できません。`)
      return
    }
    const payload = {
      collect_date: newDate,
      skipped: current?.skipped || false,
      note: current?.note || '',
      ...Object.fromEntries(PAPER_CATEGORIES.map((c) => [c.key, current?.[c.key] ?? ''])),
    }
    // 楽観的に反映してから保存する
    setRecords((prev) => [...prev.filter((r) => r.collect_date !== oldDate), { ...current, ...payload }])
    try {
      const saved = await upsertPaperRecord(payload)
      if (current?.id) await deletePaperRecord(current.id)
      setRecords((prev) => [...prev.filter((r) => r.collect_date !== oldDate && r.collect_date !== newDate), saved])
    } catch (err) {
      setError(err.message)
      load()
    }
  }

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-wide app-scroll paper-page">
        <FeatureHeader
          filters={
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
              {/* 押すと今年度へ切り替え、本日（または本日に一番近い過去）の回収日の行まで
                  スクロールする。年度は52週あり、目当ての週を探すのに毎回スクロールが要るため */}
              <button type="button" className="btn-plain reports-today-btn" onClick={handleGoToToday}>
                本日
              </button>
            </div>
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
          <>
            <PaperSummary fiscalYear={fiscalYear} summary={summary} months={months} />
            <PaperTable
              months={months}
              byDate={byDate}
              todayDate={todayDate}
              holidays={holidays}
              closedDays={closedDays}
              readOnly={readOnly}
              onSave={handleSave}
              onDateChange={handleDateChange}
            />
          </>
        )}

        <p className="settings-hint paper-legend">
          単位: kg／回収は原則毎週月曜。祝日・休館日で回収が無かった週は「中止」にすると、
          月平均の計算から外れます。日程がずれた週は日付欄を直接書き換えてください。
        </p>
      </div>
    </div>
  )
}

// 年度の合計・月平均と、月別合計の棒グラフ（Excel右側の月別集計＋グラフに相当）
function PaperSummary({ fiscalYear, summary, months }) {
  const max = Math.max(1, ...months.map((m) => m.total))
  return (
    <div className="paper-summary">
      <div className="paper-summary-figures">
        <div className="paper-figure">
          <span className="paper-figure-label">{fiscalYear}年度 合計</span>
          <span className="paper-figure-value">
            {formatKg(summary.total)}
            <span className="paper-figure-unit"> kg</span>
          </span>
        </div>
        <div className="paper-figure">
          <span className="paper-figure-label">月平均（実績{summary.monthCount}か月）</span>
          <span className="paper-figure-value">
            {summary.monthCount > 0 ? Math.round(summary.average) : '—'}
            <span className="paper-figure-unit"> kg</span>
          </span>
        </div>
      </div>
      <div className="paper-chart" role="img" aria-label={`${fiscalYear}年度の月別古紙回収量`}>
        {months.map((m) => (
          <div className="paper-chart-col" key={m.month} title={`${Number(m.month.slice(5, 7))}月: ${formatKg(m.total)}kg`}>
            <span className="paper-chart-value">{m.total > 0 ? formatKg(m.total) : ''}</span>
            <span className="paper-chart-bar" style={{ height: `${(m.total / max) * 100}%` }} />
            <span className="paper-chart-month">{Number(m.month.slice(5, 7))}月</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function PaperTable({ months, byDate, todayDate, holidays, closedDays, readOnly, onSave, onDateChange }) {
  return (
    // 表そのものを縦スクロールコンテナにして、その中で列見出しを固定する。
    // 横スクロール（overflow-x）を持つ要素はCSSの仕様で縦もスクロールコンテナになるため、
    // 列見出しの固定はページ基準では効かない（.claude/skills/sticky-header-overflow-trap）
    <div className="ui-table-wrap paper-table-wrap">
      <table className="ui-table paper-table">
        <thead>
          <tr>
            <th>回収予定日</th>
            <th className="paper-note-col">備考</th>
            {PAPER_CATEGORIES.map((c) => (
              <th key={c.key} className="is-numeric">
                {c.label}
              </th>
            ))}
            <th className="is-numeric">合計</th>
          </tr>
        </thead>
        <tbody>
          {months.map((group) => (
            <PaperMonthGroup
              key={group.month}
              group={group}
              byDate={byDate}
              todayDate={todayDate}
              holidays={holidays}
              closedDays={closedDays}
              readOnly={readOnly}
              onSave={onSave}
              onDateChange={onDateChange}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PaperMonthGroup({ group, byDate, todayDate, holidays, closedDays, readOnly, onSave, onDateChange }) {
  const monthLabel = `${group.month.slice(0, 4)}年${Number(group.month.slice(5, 7))}月`
  return (
    <>
      {/* 1列目（回収予定日）は横スクロールしても追えるよう固定するため、月見出し行も
          1列目だけは他の行と同じ幅の単独セルにしておく（colSpanでまとめない） */}
      <tr className="paper-month-row">
        <td className="ui-table-group-head">{monthLabel}</td>
        <td colSpan={PAPER_CATEGORIES.length + 1} className="ui-table-group-head" />
        <td className="ui-table-group-head is-numeric paper-month-total">
          {group.total > 0 ? formatKg(group.total) : ''}
        </td>
      </tr>
      {group.dates.map((date) => (
        <PaperRow
          key={date}
          date={date}
          record={byDate.get(date) || null}
          isToday={date === todayDate}
          holidays={holidays}
          closedDays={closedDays}
          readOnly={readOnly}
          onSave={onSave}
          onDateChange={onDateChange}
        />
      ))}
    </>
  )
}

function PaperRow({ date, record, isToday, holidays, closedDays, readOnly, onSave, onDateChange }) {
  const wd = weekdayInfo(date, holidays)
  const isClosed = closedDays.has(date)
  const skipped = Boolean(record?.skipped)
  const total = paperRowTotal(record)

  return (
    <tr className={`paper-row${skipped ? ' is-skipped' : ''}${isToday ? ' is-today' : ''}`}>
      {/* 年は月見出し行が示すので日付からは省く（「9/7（月）」）。固定列の幅を詰めて、
          狭い画面で計量値の入力欄に幅を回すため。日付そのものは透明化したネイティブの
          <input type="date"> で直接編集できる（祝日・休館日で日がずれた週を、備考への
          自由記入ではなく実際の日付に直す。src/components/ReminderForm.jsx と同じ技法） */}
      <td className={`paper-date ${wd.className}`}>
        <div className="paper-date-field">
          <input
            type="date"
            className="paper-date-native"
            value={date}
            disabled={readOnly}
            aria-label={`回収予定日 ${date}`}
            onChange={(e) => onDateChange(date, e.target.value)}
          />
          <div className="paper-date-display">
            {Number(date.slice(5, 7))}/{Number(date.slice(8, 10))}（{wd.label}）
            {wd.holidayName && <span className="paper-date-flag">{wd.holidayName}</span>}
            {!wd.holidayName && isClosed && <span className="paper-date-flag">休館日</span>}
          </div>
        </div>
      </td>
      <td className="paper-note-col">
        <div className="paper-note-row">
          <label className="paper-skip">
            <input
              type="checkbox"
              checked={skipped}
              disabled={readOnly}
              onChange={(e) => onSave(date, { skipped: e.target.checked })}
            />
            中止
          </label>
          <PaperNoteInput
            value={record?.note || ''}
            readOnly={readOnly}
            onCommit={(note) => onSave(date, { note })}
          />
        </div>
      </td>
      {PAPER_CATEGORIES.map((c) => (
        <td key={c.key} className="paper-weight-cell">
          <PaperWeightInput
            value={record?.[c.key]}
            disabled={readOnly || skipped}
            label={`${date} ${c.label}`}
            onCommit={(next) => onSave(date, { [c.key]: next })}
          />
        </td>
      ))}
      <td className="is-numeric paper-row-total">{skipped ? '—' : total > 0 ? formatKg(total) : ''}</td>
    </tr>
  )
}

// 計量値の入力。廃棄物の実測値セル（Waste.jsx の WasteCell）と同じく、フォーカス中は
// 入力途中の文字をそのまま持ち、離れたときだけ確定して保存する
function PaperWeightInput({ value, disabled, label, onCommit }) {
  const [draft, setDraft] = useState(value == null ? '' : String(value))
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!editing) setDraft(value == null ? '' : String(value))
  }, [value, editing])

  function commit() {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed === '') {
      if (value != null) onCommit('')
      return
    }
    const num = Number(trimmed)
    if (!Number.isFinite(num) || num < 0) {
      setDraft(value == null ? '' : String(value))
      return
    }
    if (Number(value) === num) return
    onCommit(num)
  }

  return (
    <input
      type="number"
      inputMode="decimal"
      step="1"
      min="0"
      className="paper-weight-input"
      value={draft}
      disabled={disabled}
      placeholder="—"
      aria-label={label}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
    />
  )
}

function PaperNoteInput({ value, readOnly, onCommit }) {
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  return (
    <input
      type="text"
      className="paper-note-input"
      value={draft}
      disabled={readOnly}
      aria-label="備考"
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false)
        if (draft !== value) onCommit(draft)
      }}
    />
  )
}
