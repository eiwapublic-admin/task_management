import { useState } from 'react'
import './SettingsPanel.css'

export default function SettingsPanel({ settings, onSave }) {
  const [fetchInterval, setFetchInterval] = useState(settings.fetch_interval_minutes)
  const [assignees, setAssignees] = useState(settings.assignees)
  const [businessKeywords, setBusinessKeywords] = useState(settings.business_keywords)

  function handleAssigneeChange(index, value) {
    setAssignees((prev) => prev.map((a, i) => (i === index ? value : a)))
  }

  function handleSubmit(e) {
    e.preventDefault()
    onSave({
      fetch_interval_minutes: fetchInterval,
      assignees,
      business_keywords: businessKeywords,
    })
  }

  return (
    <form className="settings-panel" onSubmit={handleSubmit}>
      <section>
        <h2>更新頻度</h2>
        <label>
          何分ごとにメールを取得するか（5〜120分）
          <input
            type="number"
            min={5}
            max={120}
            value={fetchInterval}
            onChange={(e) => setFetchInterval(Number(e.target.value))}
          />
        </label>
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

      <section>
        <h2>業務判定のキーワードヒント</h2>
        <textarea
          value={businessKeywords}
          onChange={(e) => setBusinessKeywords(e.target.value)}
          placeholder="例: 見積, 発注, 納期 など、Claude APIへの追加コンテキストとして使われます"
          rows={4}
        />
      </section>

      <button type="submit">保存</button>
    </form>
  )
}
