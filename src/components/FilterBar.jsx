export default function FilterBar({ assignees, selectedAssignee, onChange }) {
  return (
    <div className="filter-bar">
      <span className="filter-bar-label">担当者:</span>
      <button
        className={selectedAssignee === null ? 'filter-chip active' : 'filter-chip'}
        onClick={() => onChange(null)}
      >
        すべて
      </button>
      {assignees.map((name) => (
        <button
          key={name}
          className={selectedAssignee === name ? 'filter-chip active' : 'filter-chip'}
          onClick={() => onChange(name)}
        >
          {name}
        </button>
      ))}
    </div>
  )
}
