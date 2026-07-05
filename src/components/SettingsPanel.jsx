import { useState } from 'react'
import './SettingsPanel.css'

export default function SettingsPanel({ settings, onSave }) {
  const [fetchInterval, setFetchInterval] = useState(settings.fetch_interval_minutes)
  const [activeStart, setActiveStart] = useState(settings.active_hours_start ?? 8)
  const [activeEnd, setActiveEnd] = useState(settings.active_hours_end ?? 18)
  const [assignees, setAssignees] = useState(settings.assignees)
  const [businessKeywords, setBusinessKeywords] = useState(settings.business_keywords)
  const [orgContext, setOrgContext] = useState(settings.org_context ?? '')

  function handleAssigneeChange(index, value) {
    setAssignees((prev) => prev.map((a, i) => (i === index ? value : a)))
  }

  function handleSubmit(e) {
    e.preventDefault()
    onSave({
      fetch_interval_minutes: Number(fetchInterval),
      active_hours_start: Number(activeStart),
      active_hours_end: Number(activeEnd),
      assignees,
      business_keywords: businessKeywords,
      org_context: orgContext,
    })
  }

  return (
    <form id="settings-form" className="settings-panel" onSubmit={handleSubmit}>
      <section>
        <h2>更新頻度と時間帯</h2>
        <div className="settings-hours">
          <label>
            開始（時）
            <input
              type="number"
              min={0}
              max={23}
              step={1}
              value={activeStart}
              onChange={(e) => setActiveStart(e.target.value)}
              onBlur={(e) => {
                const n = Math.round(Number(e.target.value))
                setActiveStart(Number.isFinite(n) ? Math.min(23, Math.max(0, n)) : 8)
              }}
            />
          </label>
          <label>
            終了（時）
            <input
              type="number"
              min={1}
              max={24}
              step={1}
              value={activeEnd}
              onChange={(e) => setActiveEnd(e.target.value)}
              onBlur={(e) => {
                const n = Math.round(Number(e.target.value))
                setActiveEnd(Number.isFinite(n) ? Math.min(24, Math.max(1, n)) : 18)
              }}
            />
          </label>
          <label>
            頻度（分）
            <input
              type="number"
              min={5}
              max={120}
              step={1}
              value={fetchInterval}
              onChange={(e) => setFetchInterval(e.target.value)}
              onBlur={(e) => {
                // 範囲外・非整数の入力を 5〜120 に丸める
                const n = Math.round(Number(e.target.value))
                setFetchInterval(Number.isFinite(n) ? Math.min(120, Math.max(5, n)) : 30)
              }}
            />
          </label>
        </div>
        <p className="settings-hint">指定した時間帯で指定した頻度でメールを自動取得します。</p>
      </section>

      <section>
        <h2>担当者名</h2>
        {assignees.map((name, i) => (
          <label key={i}>
            担当者{i + 1}
            <input value={name} onChange={(e) => handleAssigneeChange(i, e.target.value)} />
          </label>
        ))}
      </section>

      <section className="settings-org">
        <h2>業務の背景・振り分けルール</h2>
        <p className="settings-hint">
          会社・担当者・取引先・振り分けの前提を記述します。ここに書いた内容がメール分類（Claude）に
          そのまま渡されます。実際の振り分け結果を見ながら、ルールを追記・調整してください。
        </p>
        <textarea
          className="settings-org-textarea"
          value={orgContext}
          onChange={(e) => setOrgContext(e.target.value)}
          placeholder="例: 「リニューアルプレート」「ダウンライト」「調光器」に関する問い合わせは岡田が担当。プロモーション/広告メールは業務タスクではない。"
          rows={22}
        />
      </section>

      <section>
        <h2>業務判定のキーワードヒント</h2>
        <textarea
          value={businessKeywords}
          onChange={(e) => setBusinessKeywords(e.target.value)}
          placeholder="例: 見積, 発注, 納期 など、Claude APIへの追加コンテキストとして使われます"
          rows={4}
        />
      </section>

    </form>
  )
}
