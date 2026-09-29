import { useState } from 'react'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import { syncBilmenCalendarMonth } from '../lib/bilmen'
import '../pages/Bilmen.css'

// 月まとめのカレンダー反映（Phase 3。2026-09-29〜。docs/bilmen-plan.md 7-2）。
// 表示中の月の予定のうち、未反映・要再反映のものを Google カレンダー「栄和共通」へまとめて反映する。
// 1件ずつ反映したいときは予定の詳細画面から行う。
//
// startMonth より前の月は反映できない（現行の FileMaker → Claris Connect が登録済みで、
// 反映すると二重になるため。サーバー側でも同じ判定で拒否する）
export default function BilmenCalendarModal({ month, schedules, startMonth, calendarReady, onClose, onDone }) {
  useBodyScrollLock()

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  // サーバーは予定日付の月で対象を決めるので、ここも予定日付で数える（日付未定は対象月に含めて表示だけする）
  const inMonth = schedules.filter((s) => (s.plan_date ? s.plan_date.slice(0, 7) === month : s.target_month === month))
  const count = (state) => inMonth.filter((s) => s.calendar_state === state).length
  const pending = count('none') + count('stale')
  const blocked = Boolean(startMonth && month < startMonth)
  const label = (m) => m.replace('-', '年') + '月'

  async function handleSync() {
    setRunning(true)
    setError('')
    setResult(null)
    try {
      const total = await syncBilmenCalendarMonth(month, setProgress)
      setResult(total)
    } catch (err) {
      setError(err.message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="ui-overlay" role="dialog" aria-modal="true" onClick={running ? undefined : result ? onDone : onClose}>
      <div className="ui-modal is-sm" onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h3 className="ui-modal-title">{label(month)}の予定を Google カレンダーへ反映</h3>
          <button
            type="button"
            className="icon-btn-close"
            onClick={result ? onDone : onClose}
            disabled={running}
            aria-label="閉じる"
          >
            ×
          </button>
        </div>

        <div className="ui-modal-body is-stacked">
          {!calendarReady && (
            <p className="dashboard-error dashboard-banner" role="alert">
              反映先のカレンダーが設定されていません（タスク設定の「カレンダー」）。
            </p>
          )}
          {blocked && (
            <p className="bilmen-calendar-blocked" role="alert">
              {label(month)}は反映できません。本システムからの反映は <strong>{label(startMonth)}分から</strong>です
              （それより前の月は現行の仕組み（FileMaker）で登録済みのため、反映すると予定が二重になります）。
            </p>
          )}

          <table className="bilmen-calendar-counts">
            <tbody>
              <tr>
                <th>未反映</th>
                <td>{count('none')} 件</td>
              </tr>
              <tr>
                <th>要再反映</th>
                <td>
                  {count('stale')} 件<span className="bilmen-calendar-hint">（反映後に日時・作業名などが変わったもの）</span>
                </td>
              </tr>
              <tr>
                <th>反映済み</th>
                <td>{count('synced')} 件</td>
              </tr>
              <tr>
                <th>対象外</th>
                <td>
                  日付未定 {count('undated')} 件・中止 {count('canceled')} 件
                </td>
              </tr>
            </tbody>
          </table>

          <p className="ui-note">
            反映先は Google カレンダー「栄和共通」です。未反映は新しく登録し、要再反映は登録済みの予定を書き換えます
            （同じ予定が二重に並ぶことはありません）。
          </p>

          {error && (
            <p className="dashboard-error dashboard-banner" role="alert">
              {error}
            </p>
          )}

          {running && progress && (
            <p className="ui-note" role="status">
              反映中… 登録 {progress.created} 件・更新 {progress.updated} 件
              {progress.failed.length > 0 && `・失敗 ${progress.failed.length} 件`}
            </p>
          )}

          {result && (
            <div className={result.failed.length ? 'bilmen-calendar-result is-warn' : 'bilmen-calendar-result'} role="status">
              <p>
                反映しました: 登録 <strong>{result.created}</strong> 件・更新 <strong>{result.updated}</strong> 件
                {result.failed.length > 0 && (
                  <>
                    ・<strong>失敗 {result.failed.length} 件</strong>
                  </>
                )}
              </p>
              {result.failed.length > 0 && (
                <ul>
                  {result.failed.map((f) => (
                    <li key={f.id}>
                      {f.plan_date?.slice(5).replace('-', '/')} {f.title}: {f.error}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="ui-modal-foot">
          <div className="ui-modal-foot-end">
            {result ? (
              <button type="button" className="btn-primary" onClick={onDone}>
                閉じる
              </button>
            ) : (
              <>
                <button type="button" className="btn-plain" onClick={onClose} disabled={running}>
                  キャンセル
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleSync}
                  disabled={running || blocked || !calendarReady || pending === 0}
                >
                  {running ? '反映中…' : pending === 0 ? '反映が必要な予定はありません' : `${pending} 件をカレンダーに反映`}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
