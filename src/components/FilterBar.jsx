import { assigneeColor } from '../lib/format'
import { UNASSIGNED } from '../lib/status'

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
            <span className="filter-chip-dot" style={{ background: assigneeColor(name) }} aria-hidden="true" />
            {name}
          </button>
        )
      })}
    </div>
  )
}
