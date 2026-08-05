import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import ConfirmDeleteButton from '../components/ConfirmDeleteButton'
import { IconHome, IconChevronLeft, IconChevronRight } from '../components/Icons'
import { getCurrentUser } from '../lib/auth'
import {
  INSPECTION_ITEMS,
  INSPECTION_BUILDINGS,
  JUDGEMENT_MARKS,
  JUDGEMENT_LABELS,
  fetchInspections,
  saveInspection,
  deleteInspection,
  fetchHolidays,
  weekdayInfo,
  currentMonthJST,
  shiftMonth,
  daysInMonth,
  todayJST,
  formatReportDate,
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
  const [holidays, setHolidays] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null) // 入力中の日付（'YYYY-MM-DD'）

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setRows(await fetchInspections({ month }))
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

  async function handleSaved(inspection) {
    setRows((prev) => {
      const others = prev.filter((r) => r.id !== inspection.id)
      return [...others, inspection]
    })
    setEditing(null)
  }

  // 削除。休館日の取り消しも同じ経路（モーダルのスイッチをオフにして保存するか、
  // モーダルの削除ボタンで記録ごと消す）。
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
        </div>

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
                  const closed = Boolean(rec?.closed)
                  const wd = weekdayInfo(date, holidays)
                  // 未入力/既存どちらも行全体のタップで詳細モーダルを開く（追加と変更を区別しない）。
                  // 未来日はまだ記録できないので、既に何かある場合を除きタップ不可にする
                  const clickable = !readOnly && (Boolean(rec) || !isFuture)
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
          defaultInspector={user?.display_name || ''}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
          onDelete={handleDelete}
        />
      )}
    </div>
  )
}

// 点検の入力。既定は「すべて良好」で、不備のある項目だけタップして×/◎に落とす。
// 休館日はモーダル下部のスイッチで切り替える（オンにすると点検データを持たないマーカーになる）。
function InspectionForm({ date, building, existing, defaultInspector, onClose, onSaved, onDelete }) {
  const [inspector, setInspector] = useState(existing?.inspector || defaultInspector)
  const [items, setItems] = useState(existing?.items || {})
  const [note, setNote] = useState(existing?.note || '')
  const [periodic, setPeriodic] = useState(existing?.periodic_result || '')
  const [closed, setClosed] = useState(Boolean(existing?.closed))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // 6月・12月は紙の様式にも定期点検結果の欄があるため、その月だけ表示する
  const monthNum = Number(date.slice(5, 7))
  const showPeriodic = monthNum === 6 || monthNum === 12

  const ngCount = Object.keys(items).length
  const allClear = ngCount === 0

  // 項目をタップするたび ○ → × → ◎ → ○ と切り替える
  function cycle(key) {
    setItems((prev) => {
      const next = { ...prev }
      const current = next[key]
      if (!current) next[key] = 'ng'
      else if (current === 'ng') next[key] = 'fixed'
      else delete next[key]
      return next
    })
  }

  async function handleSave() {
    setSaving(true)
    setError('')
    try {
      const saved = await saveInspection({
        building,
        inspected_on: date,
        inspector,
        items,
        note,
        periodic_result: showPeriodic ? periodic || null : null,
        closed,
      })
      onSaved(saved)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const groups = [...new Set(INSPECTION_ITEMS.map((i) => i.group))]

  return (
    <div className="inspection-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="inspection-modal" onClick={(e) => e.stopPropagation()}>
        <div className="inspection-modal-head">
          <h3>
            {formatReportDate(date)}　{building}
          </h3>
          <button type="button" className="icon-btn-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>

        <div className="inspection-modal-body">
          {error && (
            <p className="dashboard-error dashboard-banner" role="alert">
              {error}
            </p>
          )}

          {!closed && (
            <>
              <label className="report-field inspection-inspector">
                <span>点検者名</span>
                <input
                  type="text"
                  value={inspector}
                  onChange={(e) => setInspector(e.target.value)}
                  placeholder="点検者名"
                />
              </label>

              <p className="inspection-hint">不備があった項目だけ、下の一覧でタップしてください。</p>

              {groups.map((group) => (
                <div className="inspection-group" key={group}>
                  <h4>{group}</h4>
                  <div className="inspection-items">
                    {INSPECTION_ITEMS.filter((i) => i.group === group).map((item) => {
                      const value = items[item.key] || 'ok'
                      return (
                        <button
                          key={item.key}
                          type="button"
                          className={`inspection-item is-${value}`}
                          onClick={() => cycle(item.key)}
                          aria-label={`${item.label}: ${JUDGEMENT_LABELS[value]}`}
                        >
                          <span className="inspection-item-mark">{JUDGEMENT_MARKS[value]}</span>
                          <span className="inspection-item-label">{item.label}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </>
          )}

          <div className={`inspection-status${closed ? ' is-closed' : allClear ? ' is-clear' : ''}`}>
            {closed ? (
              <strong>休館日</strong>
            ) : allClear ? (
              <strong>すべて良好</strong>
            ) : (
              <>
                <strong>{ngCount} 件の不備があります</strong>
                <button type="button" className="btn-plain" onClick={() => setItems({})}>
                  すべて良好に戻す
                </button>
              </>
            )}
          </div>

          {!closed && ngCount > 0 && (
            <label className="report-field inspection-note-field">
              <span>不備の内容・報告事項</span>
              <textarea
                value={note}
                rows={3}
                onChange={(e) => setNote(e.target.value)}
                placeholder="不備の具体的な内容を記入してください"
              />
            </label>
          )}

          {!closed && showPeriodic && (
            <fieldset className="inspection-periodic">
              <legend>{monthNum}月の定期点検結果</legend>
              <label>
                <input
                  type="radio"
                  name="periodic"
                  checked={periodic === 'ok'}
                  onChange={() => setPeriodic('ok')}
                />
                支障無し
              </label>
              <label>
                <input
                  type="radio"
                  name="periodic"
                  checked={periodic === 'ng'}
                  onChange={() => setPeriodic('ng')}
                />
                支障有り
              </label>
            </fieldset>
          )}
        </div>

        <div className="inspection-modal-foot">
          <div className="inspection-modal-foot-left">
            {existing && (
              <ConfirmDeleteButton onConfirm={() => onDelete(existing.id)} label="この記録を削除" size={22} />
            )}
            <label className="switch-field">
              <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} />
              <span className="switch-track">
                <span className="switch-thumb" />
              </span>
              <span className="switch-label">休館日</span>
            </label>
          </div>
          <div className="inspection-modal-foot-right">
            <button type="button" className="btn-plain" onClick={onClose}>
              キャンセル
            </button>
            <button type="button" className="btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? '保存中…' : closed ? '休館日として記録' : allClear ? '異常なしで記録' : '記録する'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
