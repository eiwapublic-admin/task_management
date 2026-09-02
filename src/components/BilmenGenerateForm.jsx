import { useCallback, useEffect, useState } from 'react'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import { fetchBilmenGenerateCandidates, generateBilmenSchedules, formatTimeRange } from '../lib/bilmen'

// 予定の自動作成モーダル（docs/bilmen-plan.md 5-3）。
//
//   1. 対象年月を選ぶ（既定＝翌月。現行の運用サイクルが「翌月分を当月中に確定」のため）
//   2. その月を実施月に含む有効なマスタを一覧表示し、チェックで取捨選択（既定＝全選択）
//   3. 「作成」で予定を一括生成。予定日付・作業IDは未入力のまま作り、一覧の
//      「未確定」グループで人が埋めて確定する
//
// 不規則周期（'3年に1回（2025年〜）' 等）は機械判定しない方針のため、パターンがある行には
// 注意アイコンとパターン文字列を出し、「今年は対象か」を人が判断できるようにする（1章）。
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
      // 既定は全選択（作成済みのものは除く）
      setSelected(new Set(rows.filter((r) => !r.created).map((r) => r.id)))
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

  const selectable = candidates.filter((c) => !c.created)

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
              <div className="bilmen-generate-actions">
                <button
                  type="button"
                  className="btn-plain"
                  onClick={() => setSelected(new Set(selectable.map((c) => c.id)))}
                >
                  すべて選ぶ
                </button>
                <button type="button" className="btn-plain" onClick={() => setSelected(new Set())}>
                  すべて外す
                </button>
              </div>

              <ul className="bilmen-generate-list">
                {candidates.map((c) => (
                  <li key={c.id} className={`bilmen-generate-item${c.created ? ' is-created' : ''}`}>
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
                    {(c.cycle_pattern || c.day_pattern) && (
                      <span className="ui-badge is-warn" title="不規則な周期です。今年が対象かご確認ください">
                        ⚠ {c.cycle_pattern || c.day_pattern}
                      </span>
                    )}
                  </li>
                ))}
              </ul>

              <p className="ui-note">
                作業マスタの実施月に {Number(month.slice(5, 7))} 月を含む作業が対象です。予定日付と作業IDは
                未入力のまま作成するので、一覧の「未確定」グループで入力して確定してください。
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
