import { assigneeColor } from '../lib/format'
import { UNASSIGNED } from '../lib/status'

// チップの●色は指定の固定色にする（2026-08-18）。設定で追加された未知の担当者名は
// 従来どおりハッシュ由来の色にフォールバックする
const FIXED_CHIP_COLORS = {
  橋口: 'var(--surface-inverse)',
  西川: 'var(--color-primary)',
  岡田: 'var(--status-done)',
  [UNASSIGNED]: 'var(--text-muted)',
}

function chipColor(name) {
  return FIXED_CHIP_COLORS[name] || assigneeColor(name)
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
