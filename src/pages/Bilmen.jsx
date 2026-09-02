import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import TimeInput from '../components/TimeInput'
import BilmenScheduleForm from '../components/BilmenScheduleForm'
import BilmenGenerateForm from '../components/BilmenGenerateForm'
import { IconChevronLeft, IconChevronRight, IconSearch } from '../components/Icons'
import { getCurrentUser, isLimitedRole } from '../lib/auth'
import {
  fetchBilmenSchedules,
  fetchBilmenMasters,
  updateBilmenSchedule,
  formatActual,
  isOverdueActual,
  isUnsettled,
  toTimeValue,
} from '../lib/bilmen'
import { currentMonthJST, fetchHolidays, shiftMonth, todayJST, weekdayInfo } from '../lib/reports'
import './Dashboard.css'
import './Bilmen.css'

// メンテナンス予定一覧（docs/bilmen-plan.md 2-1・5-1）。ビルメンセクションのホーム。
//
// 月ごとのグルーピングで新しい月が上。各月グループの先頭には、予定日付か作業IDが
// 未入力の行を「未確定」としてまとめる（確定作業が残っていることを明示するため。5-3）。
// 予定時刻・入室・報知・実績日時は一覧の上でそのまま直せる（その場編集）。
//
// owner（小泉産業様）は閲覧のみ（10章）。書き込みの正はサーバー側にある。
//
// 掲示PDF・案内メール・今月の注釈（Phase 2・4）とカレンダー反映（Phase 3）は
// 月見出し・詳細モーダルにボタンが増える形で後から入る。

// 一度に読み込む月数。既定は直近12ヶ月で、「もっと見る」で12ヶ月ずつ遡る（11章）
const MONTHS_STEP = 12

export default function Bilmen() {
  const readOnly = isLimitedRole(getCurrentUser())
  const today = todayJST()

  const [month, setMonth] = useState(currentMonthJST)
  const [months, setMonths] = useState(MONTHS_STEP)
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

  // 検索中は月の範囲を無視して全期間から探す（サーバー側も同じ扱い）
  const searching = query.trim().length > 0

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [scheduleRows, masterRows] = await Promise.all([
        fetchBilmenSchedules(searching ? { q: query.trim() } : { month, months }),
        fetchBilmenMasters(),
      ])
      setSchedules(scheduleRows)
      setMasters(masterRows)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [month, months, query, searching])

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

  // 対象月でグルーピングし、各月の中を「未確定」と「確定済み」に分ける。
  // API が target_month の降順・予定日付の昇順で返すので、その並びをそのまま保つ
  const groups = useMemo(() => {
    const map = new Map()
    for (const s of schedules) {
      if (!map.has(s.target_month)) map.set(s.target_month, { month: s.target_month, unsettled: [], settled: [] })
      map.get(s.target_month)[isUnsettled(s) ? 'unsettled' : 'settled'].push(s)
    }
    return [...map.values()]
  }, [schedules])

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
        {date.replaceAll('-', '/')} ({label})
        {holidayName && <span className="bilmen-holiday-name">{holidayName}</span>}
      </span>
    )
  }

  function renderRow(s) {
    const overdue = isOverdueActual(s, today)
    return (
      <tr key={s.id} className={`bilmen-row${s.canceled ? ' is-canceled' : ''}`}>
        <td data-label="予定日付">{renderDate(s.plan_date)}</td>
        <td data-label="予定時刻" className="bilmen-time-cell">
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
        </td>
        <td data-label="作業">
          <span className="bilmen-cell-stack">
            <button type="button" className="bilmen-title-btn" onClick={() => setEditing(s)}>
              {s.title}
            </button>
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
        <td data-label="担当">
          <span className="bilmen-cell-stack">
            <span className="bilmen-sub">{s.jurisdiction || ''}</span>
            <span className="bilmen-main">{s.vendor_name || ''}</span>
          </span>
        </td>
        <td data-label="入室" className="bilmen-check-cell">
          <input
            type="checkbox"
            checked={s.enter_room}
            disabled={readOnly}
            onChange={(e) => patchSchedule(s.id, { enter_room: e.target.checked })}
            aria-label={`${s.title} は入室作業`}
          />
        </td>
        <td data-label="報知" className="bilmen-check-cell">
          <input
            type="checkbox"
            checked={s.notify}
            disabled={readOnly}
            onChange={(e) => patchSchedule(s.id, { notify: e.target.checked })}
            aria-label={`${s.title} を掲示・案内メールに載せる`}
          />
        </td>
        <td data-label="実績">
          <span className="bilmen-cell-stack">
          {!readOnly && (
            <button
              type="button"
              className={`bilmen-copy-btn${overdue ? ' is-overdue' : ''}`}
              onClick={() => handleCopyPlan(s)}
              disabled={!s.plan_date}
              title={s.plan_date ? '予定日時をそのまま実績へ写す' : '予定日付が未入力のため写せません'}
            >
              予定通り ➡
            </button>
          )}
          <span className="bilmen-actual">{formatActual(s.actual_date, s.actual_start) || '—'}</span>
          </span>
        </td>
        <td data-label="報告書確認">
          <input
            type="date"
            className="ui-input is-compact"
            value={s.report_confirmed_on || ''}
            disabled={readOnly}
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
            readOnly ? null : (
              <>
                <button type="button" className="btn-primary" onClick={() => setGenerating(true)}>
                  予定の自動作成
                </button>
                <button
                  type="button"
                  className="icon-btn-add"
                  onClick={() => setEditing('new')}
                  aria-label="予定を追加"
                  title="予定を追加"
                >
                  ＋
                </button>
              </>
            )
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
        {info && <p className="dashboard-banner">{info}</p>}

        {loading ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : groups.length === 0 ? (
          <p className="ui-empty">
            {searching
              ? '該当する予定が見つかりません。'
              : 'この期間の予定がまだありません。「予定の自動作成」から翌月分を作成できます。'}
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
                {groups.map((g) => (
                  <Fragment key={g.month}>
                    <tr>
                      <td colSpan={8} className="ui-table-group-head">
                        {g.month.replace('-', '年')}月
                        <span className="bilmen-group-count">
                          {g.settled.length + g.unsettled.length}件
                          {g.unsettled.length > 0 && ` ／ 未確定 ${g.unsettled.length}件`}
                        </span>
                      </td>
                    </tr>
                    {g.unsettled.length > 0 && (
                      <tr>
                        <td colSpan={8} className="bilmen-subgroup-head">
                          未確定（予定日付・作業IDが未入力）
                        </td>
                      </tr>
                    )}
                    {g.unsettled.map(renderRow)}
                    {g.settled.map(renderRow)}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && !searching && groups.length > 0 && (
          <div className="bilmen-more">
            <button type="button" className="btn-plain" onClick={() => setMonths((m) => m + MONTHS_STEP)}>
              もっと見る（さらに{MONTHS_STEP}ヶ月前まで）
            </button>
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
    </div>
  )
}
