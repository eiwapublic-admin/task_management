// 表示系の共通ユーティリティ（日付整形・担当者色・期限緊急度）

export function formatDate(value) {
  if (!value) return null
  return new Date(value).toLocaleDateString('ja-JP')
}

export function formatDateTime(value) {
  if (!value) return null
  return new Date(value).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// 担当者名から決定的にアバター色を割り当てる（同じ名前は常に同じ色）
const AVATAR_COLORS = ['#2563eb', '#7c3aed', '#0891b2', '#db2777', '#059669', '#ea580c']

// 特定の担当者は固定色にする（2026-08-18にタスク側の担当者フィルタで導入。日報側の
// 担当者マーク（ReportList.jsx）も同じ色に揃えるため、ここに集約して両方から参照する。
// 2026-08-25）
const FIXED_ASSIGNEE_COLORS = {
  橋口: 'var(--surface-inverse)',
  西川: 'var(--color-primary)',
  岡田: 'var(--status-done)',
}

export function assigneeColor(name) {
  if (!name) return 'var(--text-muted)'
  if (FIXED_ASSIGNEE_COLORS[name]) return FIXED_ASSIGNEE_COLORS[name]
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

export function assigneeInitial(name) {
  return name ? name.trim().charAt(0) : '?'
}

// 期限の緊急度を判定する。level は overdue / soon / normal のいずれか、期限なしは null。
export function dueStatus(dueDate, now = new Date()) {
  if (!dueDate) return null
  const due = new Date(dueDate)
  // 日付単位で比較（時刻は無視）
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const target = new Date(due.getFullYear(), due.getMonth(), due.getDate())
  const diffDays = Math.round((target - today) / 86400000)

  if (diffDays < 0) return { level: 'overdue', label: `期限超過（${-diffDays}日）` }
  if (diffDays === 0) return { level: 'soon', label: '本日期限' }
  if (diffDays <= 2) return { level: 'soon', label: `あと${diffDays}日` }
  return { level: 'normal', label: null }
}
