import { assigneeColor } from '../lib/format'

export default function FilterBar({ assignees, selectedAssignee, onChange }) {
  return (
    <div className="filter-bar" role="group" aria-label="担当者で絞り込み">
      <span className="filter-bar-label">担当者:</span>
      <button
        className={selectedAssignee === null ? 'filter-chip active' : 'filter-chip'}
        aria-pressed={selectedAssignee === null}
        onClick={() => onChange(null)}
      >
        すべて
      </button>
      {assignees.map((name) => (
        <button
          key={name}
          className={selectedAssignee === name ? 'filter-chip active' : 'filter-chip'}
          aria-pressed={selectedAssignee === name}
          onClick={() => onChange(name)}
        >
          <span className="filter-chip-dot" style={{ background: assigneeColor(name) }} aria-hidden="true" />
          {name}
        </button>
      ))}
    </div>
  )
}
