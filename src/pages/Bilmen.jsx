import { useCallback, useEffect, useMemo, useState } from 'react'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import TimeInput from '../components/TimeInput'
import BilmenScheduleForm from '../components/BilmenScheduleForm'
import BilmenGenerateForm from '../components/BilmenGenerateForm'
import BilmenNotifyModal from '../components/BilmenNotifyModal'
import { IconChevronLeft, IconChevronRight, IconSearch, IconDocument, IconMail } from '../components/Icons'
import { getCurrentUser, isLimitedRole } from '../lib/auth'
import useBilmenSchedulePdfExport from '../hooks/useBilmenSchedulePdfExport'
import useBilmenNoticePdfExport from '../hooks/useBilmenNoticePdfExport'
import {
  fetchBilmenSchedules,
  fetchBilmenMasters,
  updateBilmenSchedule,
  formatActual,
  formatMonthDay,
  isOverdueActual,
  isUnsettled,
  toTimeValue,
} from '../lib/bilmen'
import { currentMonthJST, fetchHolidays, shiftMonth, todayJST, weekdayInfo } from '../lib/reports'
import './Dashboard.css'
import './Bilmen.css'

// メンテナンス予定一覧（docs/bilmen-plan.md 2-1・5-1）。ビルメンセクションのホーム。
//
// ヘッダーの年月選択で対象月を1つ選び、その月だけを表示する（2026-09-03の依頼で
// 12ヶ月まとめ表示・月グループ見出し・「もっと見る」を廃止した。年月はヘッダで
// 選べるため月見出し行が冗長で、他の月の明細も同時に見せる必要が無いという指摘）。
// 未確定（予定日付・作業IDが未入力）の行だけは月内の先頭にまとめて出す（5-3）。
//
// 入室・報知は一覧上では表示のみ（誤クリック防止。編集は詳細モーダルで行う）。
// 予定時刻・実績日時・報告書確認は引き続き一覧上でその場編集できる（PCのみ。
// モバイルは日付・開始時刻・作業のみを表示し、行のどこをタップしても詳細モーダルが開く）。
//
// owner（小泉産業様）は閲覧のみ（10章）。書き込みの正はサーバー側にある。
// 掲示PDF（日程表・連絡票）・テナントへの報知は2026-09-03〜。カレンダー反映（Phase 3）は
// 詳細モーダルにボタンが増える形で後から入る。
export default function Bilmen() {
  const readOnly = isLimitedRole(getCurrentUser())
  const today = todayJST()

  const [month, setMonth] = useState(currentMonthJST)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [schedules, setSchedules] = useState([])
  const [masters, setMasters] = useState([])
  const [holidays, setHolidays] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [editing, setEditing] = useState(null) // null | 'new' | schedule
  const [generating, setGenerating] = useState(false)
  const [notifying, setNotifying] = useState(false)

  const scheduleExport = useBilmenSchedulePdfExport()
  const noticeExport = useBilmenNoticePdfExport()

  // 検索中は月の範囲を無視して全期間から探す（サーバー側も同じ扱い）
  const searching = query.trim().length > 0

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [scheduleRows, masterRows] = await Promise.all([
        fetchBilmenSchedules(searching ? { q: query.trim() } : { month, months: 1 }),
        fetchBilmenMasters(),
      ])
      setSchedules(scheduleRows)
      setMasters(masterRows)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [month, query, searching])

  useEffect(() => {
    load()
  }, [load])

  // 祝日は日付列の色分けにだけ使う。取得できなくても一覧は出す（土日判定は暦から分かる）
  useEffect(() => {
    fetchHolidays()
      .then(setHolidays)
      .catch(() => setHolidays({}))
  }, [])

  const vendorOptions = useMemo(() => {
    const seen = new Set()
    for (const m of masters) if (m.vendor_name) seen.add(m.vendor_name)
    for (const s of schedules) if (s.vendor_name) seen.add(s.vendor_name)
    return [...seen]
  }, [masters, schedules])

  // 未確定（予定日付・作業IDが未入力）を先頭にまとめ、それ以外は元の並び（API が
  // 予定日付の昇順で返す）のまま。検索時は月をまたぐため未確定/確定済みの区別はしない
  const { unsettled, settled } = useMemo(() => {
    if (searching) return { unsettled: [], settled: schedules }
    const unsettled = []
    const settled = []
    for (const s of schedules) (isUnsettled(s) ? unsettled : settled).push(s)
    return { unsettled, settled }
  }, [schedules, searching])

  // その場編集。失敗したら画面の値を戻さず（サーバー値で再読込せず）エラーだけ出すと
  // 表示と実体がずれるため、成功した行だけを差し替える形にする
  async function patchSchedule(id, patch) {
    setError('')
    const before = schedules
    // 先に画面へ反映して待ち時間を感じさせない（失敗時は元に戻す）
    setSchedules((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))
    try {
      const saved = await updateBilmenSchedule(id, patch)
      setSchedules((prev) => prev.map((s) => (s.id === id ? saved : s)))
    } catch (err) {
      setSchedules(before)
      setError(err.message)
    }
  }

  // 「予定通り ➡」。予定の日付・時刻をそのまま実績へ写す（2-1）
  function handleCopyPlan(schedule) {
    if (!schedule.plan_date) {
      setError('予定日付が未入力のため実績へ写せません')
      return
    }
    patchSchedule(schedule.id, {
      actual_date: schedule.plan_date,
      actual_start: toTimeValue(schedule.plan_start),
      actual_end: toTimeValue(schedule.plan_end),
    })
  }

  function handleSaved() {
    setEditing(null)
    load()
  }

  function handleGenerated(result, targetMonth) {
    setGenerating(false)
    setInfo(
      result.created > 0
        ? `${targetMonth.replace('-', '年')}月の予定を ${result.created} 件作成しました。日付と作業IDを入れて確定してください。` +
          (result.skipped > 0 ? `（作成済みの ${result.skipped} 件は飛ばしました）` : '')
        : '新たに作成できる予定はありませんでした（選んだ作業はすべて作成済みです）。',
    )
    if (result.created > 0) setMonth(targetMonth)
    load()
  }

  function renderDate(date) {
    if (!date) return <span className="bilmen-undecided">日付未定</span>
    const { label, className, holidayName } = weekdayInfo(date, holidays)
    return (
      <span className={`bilmen-date ${className}`}>
        {formatMonthDay(date)} ({label})
        {holidayName && <span className="bilmen-holiday-name">{holidayName}</span>}
      </span>
    )
  }

  function renderRow(s) {
    const overdue = isOverdueActual(s, today)
    return (
      <tr key={s.id} className={`bilmen-row is-clickable${s.canceled ? ' is-canceled' : ''}`} onClick={() => setEditing(s)}>
        <td data-label="予定日付" className="bilmen-col-date">
          {renderDate(s.plan_date)}
        </td>
        <td data-label="予定時刻" className="bilmen-col-time bilmen-time-cell">
          <span className="bilmen-time-display">{toTimeValue(s.plan_start) || '—'}</span>
          <span className="bilmen-time-edit" onClick={(e) => e.stopPropagation()}>
            <TimeInput
              className="ui-input is-compact"
              value={toTimeValue(s.plan_start)}
              disabled={readOnly}
              onChange={(v) => patchSchedule(s.id, { plan_start: v })}
              aria-label="予定開始時刻"
            />
            <span aria-hidden="true">〜</span>
            <TimeInput
              className="ui-input is-compact"
              value={toTimeValue(s.plan_end)}
              disabled={readOnly}
              onChange={(v) => patchSchedule(s.id, { plan_end: v })}
              aria-label="予定終了時刻"
            />
          </span>
        </td>
        <td data-label="作業" className="bilmen-col-title">
          <span className="bilmen-cell-stack">
            <span className="bilmen-title-text">{s.title}</span>
            {s.title_note && <span className="bilmen-title-note">{s.title_note}</span>}
            <span className="bilmen-row-sub">
              {s.work_no ? (
                <span className="bilmen-work-no">{s.work_no}</span>
              ) : (
                <span className="bilmen-undecided">作業ID未入力</span>
              )}
              {s.canceled && <span className="ui-badge is-danger">中止</span>}
              {s.prep_note && <span className="ui-badge">管理側作業・準備</span>}
            </span>
          </span>
        </td>
        <td data-label="担当" className="bilmen-col-vendor">
          <span className="bilmen-cell-stack">
            <span className="bilmen-sub">{s.jurisdiction || ''}</span>
            <span className="bilmen-main">{s.vendor_name || ''}</span>
          </span>
        </td>
        <td data-label="入室" className="bilmen-col-enter bilmen-check-cell">
          <span className="bilmen-check-display">{s.enter_room ? '✓' : ''}</span>
        </td>
        <td data-label="報知" className="bilmen-col-notify bilmen-check-cell">
          <span className="bilmen-check-display">{s.notify ? '✓' : ''}</span>
        </td>
        <td data-label="実績" className="bilmen-col-actual">
          <span className="bilmen-cell-stack">
            {!readOnly && (
              <button
                type="button"
                className={`bilmen-copy-btn${overdue ? ' is-overdue' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  handleCopyPlan(s)
                }}
                disabled={!s.plan_date}
                title={s.plan_date ? '予定日時をそのまま実績へ写す' : '予定日付が未入力のため写せません'}
              >
                予定通り ➡
              </button>
            )}
            <span className="bilmen-actual">{formatActual(s.actual_date, s.actual_start) || '—'}</span>
          </span>
        </td>
        <td data-label="報告書確認" className="bilmen-col-report">
          <input
            type="date"
            className="ui-input is-compact"
            value={s.report_confirmed_on || ''}
            disabled={readOnly}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => patchSchedule(s.id, { report_confirmed_on: e.target.value })}
            aria-label="報告書確認日付"
          />
        </td>
      </tr>
    )
  }

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-wide app-scroll">
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
                  disabled={searching}
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
                  disabled={searching}
                >
                  <IconChevronRight size={28} />
                </button>
              </div>
              <button
                type="button"
                className={`icon-btn-search${searchOpen || searching ? ' is-active' : ''}`}
                onClick={() => setSearchOpen((v) => !v)}
                aria-label="予定を検索"
                title="予定を検索"
              >
                <IconSearch size={20} />
              </button>
            </>
          }
          actions={
            <>
              <button
                type="button"
                className="btn-plain"
                onClick={() => scheduleExport.download(month, schedules, holidays)}
                disabled={scheduleExport.busy}
                title="1階掲示用の日程表PDFを出力"
              >
                <IconDocument size={16} />
                <span className="btn-plain-label">日程表</span>
              </button>
              <button
                type="button"
                className="btn-plain"
                onClick={() => noticeExport.download(month, schedules)}
                disabled={noticeExport.busy}
                title="EV掲示・投函・メール添付用の連絡票PDFを出力"
              >
                <IconDocument size={16} />
                <span className="btn-plain-label">連絡票</span>
              </button>
              {!readOnly && (
                <button type="button" className="btn-plain" onClick={() => setNotifying(true)}>
                  <IconMail size={16} />
                  <span className="btn-plain-label">テナントへ報知</span>
                </button>
              )}
              {!readOnly && (
                <button type="button" className="btn-primary" onClick={() => setGenerating(true)}>
                  予定の自動作成
                </button>
              )}
              {!readOnly && (
                <button
                  type="button"
                  className="icon-btn-add"
                  onClick={() => setEditing('new')}
                  aria-label="予定を追加"
                  title="予定を追加"
                >
                  ＋
                </button>
              )}
            </>
          }
        >
          {(searchOpen || searching) && (
            <div className="reports-search-bar">
              <IconSearch size={18} />
              <input
                type="search"
                className="reports-search-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="作業名・作業ID・担当会社などで検索（全期間）"
                aria-label="作業名・作業ID・担当会社などで検索"
              />
              {query && (
                <button
                  type="button"
                  className="reports-search-clear"
                  onClick={() => setQuery('')}
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
        {scheduleExport.error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {scheduleExport.error}
          </p>
        )}
        {noticeExport.error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {noticeExport.error}
          </p>
        )}
        {info && <p className="dashboard-banner">{info}</p>}

        {loading ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : schedules.length === 0 ? (
          <p className="ui-empty">
            {searching
              ? '該当する予定が見つかりません。'
              : 'この月の予定がまだありません。「予定の自動作成」から作成できます。'}
          </p>
        ) : (
          <div className="ui-table-wrap">
            <table className="ui-table bilmen-table">
              <thead>
                <tr>
                  <th>予定日付</th>
                  <th>予定時刻</th>
                  <th>作業</th>
                  <th>管轄／担当会社</th>
                  <th>入室</th>
                  <th>報知</th>
                  <th>実績日時</th>
                  <th>報告書確認</th>
                </tr>
              </thead>
              <tbody>
                {unsettled.length > 0 && (
                  <tr>
                    <td colSpan={8} className="bilmen-subgroup-head">
                      未確定（予定日付・作業IDが未入力）
                    </td>
                  </tr>
                )}
                {unsettled.map(renderRow)}
                {settled.map(renderRow)}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <BilmenScheduleForm
          key={editing === 'new' ? 'new' : editing.id}
          existing={editing === 'new' ? null : editing}
          month={month}
          masters={masters}
          vendorOptions={vendorOptions}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
          onDeleted={handleSaved}
        />
      )}

      {generating && (
        <BilmenGenerateForm
          defaultMonth={shiftMonth(currentMonthJST(), 1)}
          onClose={() => setGenerating(false)}
          onGenerated={handleGenerated}
        />
      )}

      {notifying && (
        <BilmenNotifyModal
          month={month}
          schedules={schedules}
          onDownloadNotice={(m, s) => noticeExport.download(m, s)}
          onClose={() => setNotifying(false)}
        />
      )}

      {scheduleExport.sheetsPortal}
      {scheduleExport.previewModal}
      {scheduleExport.busyOverlay}
      {noticeExport.sheetsPortal}
      {noticeExport.previewModal}
      {noticeExport.busyOverlay}
    </div>
  )
}
