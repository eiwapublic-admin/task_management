import { useEffect, useState } from 'react'
import ConfirmDeleteButton from './ConfirmDeleteButton'
import {
  INSPECTION_ITEMS,
  JUDGEMENT_MARKS,
  JUDGEMENT_LABELS,
  saveInspection,
  markClosedDay,
  unmarkClosedDay,
  formatReportDate,
} from '../lib/reports'

// 自主検査表（日常）の入力モーダル。自主検査表画面（Inspections.jsx）と、日報一覧の
// 「自主検査入力」ボタン（ReportList.jsx。当日分のショートカット）の両方から使う共通部品。
//
// 既定は「すべて良好」で、不備のある項目だけタップして×/◎に落とす。
// 休館日はモーダル下部のスイッチで切り替える。休館日はプロジェクト共通の情報
// （closed_days テーブル）のため、自主検査表の保存とは別の専用APIで登録/解除する
// （/api/report/closed-days。日報一覧側でも同じ休館日情報を参照する）。
//
// initialClosed: 開いた時点でその日が既に休館日かどうか（呼び出し側が別途取得して渡す）。
export default function InspectionForm({
  date,
  building,
  existing,
  initialClosed,
  defaultInspector,
  onClose,
  onSaved,
  onDelete,
}) {
  const [inspector, setInspector] = useState(existing?.inspector || defaultInspector)
  const [items, setItems] = useState(existing?.items || {})
  const [note, setNote] = useState(existing?.note || '')
  const [periodic, setPeriodic] = useState(existing?.periodic_result || '')
  const [closed, setClosed] = useState(Boolean(initialClosed))
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
      if (closed) {
        if (!initialClosed) await markClosedDay(date)
        onSaved({ closed: true, inspected_on: date })
      } else {
        if (initialClosed) await unmarkClosedDay(date)
        const saved = await saveInspection({
          building,
          inspected_on: date,
          inspector,
          items,
          note,
          periodic_result: showPeriodic ? periodic || null : null,
        })
        onSaved({ ...saved, closed: false })
      }
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
