import { useCallback, useEffect, useState } from 'react'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import {
  fetchBilmenGenerateCandidates,
  generateBilmenSchedules,
  formatTimeRange,
  formatCycle,
  nextCycleYear,
} from '../lib/bilmen'

// 予定の自動作成モーダル（docs/bilmen-plan.md 5-3）。
//
//   1. 対象年月を選ぶ（既定＝翌月。現行の運用サイクルが「翌月分を当月中に確定」のため）
//   2. その月を実施月に含む有効なマスタを一覧表示し、チェックで取捨選択
//      （既定＝作成済みと「今年は対象外」を除いた全選択）
//   3. 「作成」で予定を一括生成。予定日付・作業IDは未入力のまま作り、一覧の
//      「未確定」グループで人が埋めて確定する
//
// 数年に1回の作業（2年に1回 等）は、マスタの cycle_years / cycle_anchor_year から
// サーバー側が実施年かを判定して in_cycle を返す（5-3-1。2026-09-15〜）。実施年でない行は
// **既定で未選択にし「今年は対象外」バッジを出す**が、チェック自体は外していない
// （例外的に実施するケースのために人が選び直せるようにしておく）。
// day_pattern（'月半ば' 等の実施日のメモ）は従来どおり注意アイコンで見せるだけ。
export default function BilmenGenerateForm({ defaultMonth, onClose, onGenerated }) {
  useBodyScrollLock()

  const [month, setMonth] = useState(defaultMonth)
  const [candidates, setCandidates] = useState([])
  const [selected, setSelected] = useState(() => new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (targetMonth) => {
    setLoading(true)
    setError('')
    try {
      const rows = await fetchBilmenGenerateCandidates(targetMonth)
      setCandidates(rows)
      // 既定は全選択（作成済みと、今年が実施年でないものは除く）
      setSelected(new Set(rows.filter((r) => !r.created && r.in_cycle !== false).map((r) => r.id)))
    } catch (err) {
      setError(err.message)
      setCandidates([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(month)
  }, [load, month])

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleGenerate() {
    setError('')
    if (selected.size === 0) return setError('作成する作業を1件以上選んでください')
    setSaving(true)
    try {
      const result = await generateBilmenSchedules(month, [...selected])
      onGenerated(result, month)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  const year = Number(month.slice(0, 4))
  // 「すべて選ぶ」が拾うのは、作成済みでも対象外の年でもないものだけ
  const selectable = candidates.filter((c) => !c.created && c.in_cycle !== false)
  const outOfCycleCount = candidates.filter((c) => c.in_cycle === false).length

  return (
    <div className="ui-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="ui-modal is-sm" onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h3 className="ui-modal-title">予定の自動作成</h3>
          <button type="button" className="icon-btn-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>

        <div className="ui-modal-body is-stacked">
          {error && (
            <p className="dashboard-error dashboard-banner" role="alert">
              {error}
            </p>
          )}

          <label className="ui-field">
            <span>対象年月</span>
            <input type="month" className="ui-input" value={month} onChange={(e) => setMonth(e.target.value)} />
          </label>

          {loading ? (
            <p className="dashboard-loading">読み込み中…</p>
          ) : candidates.length === 0 ? (
            <p className="ui-empty">この月を実施月に含む作業マスタがありません。</p>
          ) : (
            <>
              {selectable.length === 0 && (
                <p className="ui-empty">
                  {candidates.every((c) => c.created)
                    ? 'この月の作業はすべて作成済みです。チェックボックスは選択できません。'
                    : `この月に選べる作業がありません（作成済み、または ${year} 年が実施年でないもののみ）。`}
                </p>
              )}

              <div className="bilmen-generate-actions">
                <button
                  type="button"
                  className="btn-plain"
                  onClick={() => setSelected(new Set(selectable.map((c) => c.id)))}
                  disabled={selectable.length === 0}
                >
                  すべて選ぶ
                </button>
                <button type="button" className="btn-plain" onClick={() => setSelected(new Set())}>
                  すべて外す
                </button>
              </div>

              <ul className="bilmen-generate-list">
                {candidates.map((c) => (
                  <li
                    key={c.id}
                    className={`bilmen-generate-item${c.created ? ' is-created' : ''}${
                      c.in_cycle === false ? ' is-out-of-cycle' : ''
                    }`}
                  >
                    <label className="bilmen-check-field">
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        disabled={c.created}
                        onChange={() => toggle(c.id)}
                      />
                      <span className="bilmen-generate-title">
                        {c.title}
                        <span className="bilmen-sub">
                          {[c.vendor_name, formatTimeRange(c.plan_start, c.plan_end)].filter(Boolean).join(' ・ ')}
                        </span>
                      </span>
                    </label>
                    {c.created && <span className="ui-badge">作成済み</span>}
                    {/* バッジは nowrap なので短くし、周期の詳細はツールチップに回す */}
                    {c.in_cycle === false && (
                      <span
                        className="ui-badge"
                        title={`${formatCycle(c)}の作業です。次の実施年は ${nextCycleYear(c, year)} 年`}
                      >
                        {year}年は対象外
                      </span>
                    )}
                    {formatCycle(c) && <span className="ui-badge">{formatCycle(c)}</span>}
                    {c.day_pattern && (
                      <span className="ui-badge is-warn" title="実施日の目安です">
                        ⚠ {c.day_pattern}
                      </span>
                    )}
                  </li>
                ))}
              </ul>

              <p className="ui-note">
                作業マスタの実施月に {Number(month.slice(5, 7))} 月を含む作業が対象です。予定日付と作業IDは
                未入力のまま作成するので、一覧の「未確定」グループで入力して確定してください。
                {outOfCycleCount > 0 && (
                  <>
                    <br />
                    数年に1回の作業のうち {outOfCycleCount} 件は {year} 年が実施年ではないため、
                    最初から選択を外しています（例外的に実施する場合はチェックを付けてください）。
                  </>
                )}
              </p>
            </>
          )}
        </div>

        <div className="ui-modal-foot">
          <div className="ui-modal-foot-end">
            <button type="button" className="btn-plain" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={handleGenerate}
              disabled={saving || loading || selected.size === 0}
            >
              {saving ? '作成中…' : `${selected.size}件を作成`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
