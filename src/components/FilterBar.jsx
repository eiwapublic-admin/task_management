import { assigneeColor } from '../lib/format'
import { UNASSIGNED } from '../lib/status'

// チップの●色は指定の固定色にする（2026-08-18）。固定色そのものは`assigneeColor`に
// 集約済み（2026-08-25。日報側のマークとも共通化するため）。「未設定」はタスク側だけの
// 概念のためここで個別に扱う
function chipColor(name) {
  return name === UNASSIGNED ? 'var(--text-muted)' : assigneeColor(name)
}

// 「未設定」チップはiPhone幅でヘッダが2行になるのを避けるため短い表記にする
// （2026-08-18。中身のフィルタ判定は引き続き UNASSIGNED の完全な値で行う）
function chipLabel(name) {
  return name === UNASSIGNED ? '未設定' : name
}

// 担当者ごとの独立トグル（2026-08-18。旧「すべて」＋単一選択から変更）。
// 既定は全員オン＝従来の「すべて」と同じ表示。押すとその担当者だけ表示から外れるため、
// 他を全部オフにすれば「未割当」だけを表示する、といった組み合わせもできる。
export default function FilterBar({ assignees, hiddenAssignees, onToggle }) {
  const options = [...assignees, UNASSIGNED]
  return (
    <div className="filter-bar" role="group" aria-label="担当者で絞り込み">
      <span className="filter-bar-label">担当者:</span>
      {options.map((name) => {
        const isOn = !hiddenAssignees.has(name)
        return (
          <button
            key={name}
            type="button"
            className={isOn ? 'filter-chip active' : 'filter-chip'}
            aria-pressed={isOn}
            onClick={() => onToggle(name)}
          >
            <span className="filter-chip-dot" style={{ background: chipColor(name) }} aria-hidden="true" />
            {chipLabel(name)}
          </button>
        )
      })}
    </div>
  )
}
