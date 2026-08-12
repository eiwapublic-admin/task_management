import { authFetch } from './api'

// 備品管理（Phase 1。2026-08-12〜）の API 呼び出し・共通定数をまとめる。
// docs/equipment-plan.md 参照。テナント設置・新規入替・署名は Phase 2 で追加する。

// 入庫理由（择一ボタンの選択肢。表示順）
export const EQUIPMENT_IN_REASONS = [
  { key: 'procure', label: '調達' },
  { key: 'deferred', label: '繰延登録' },
  { key: 'adjust', label: '在庫調整' },
]

// 出庫理由。Phase 1 では tenant（テナント設置）・replace（新規入替）は未対応
export const EQUIPMENT_OUT_REASONS = [
  { key: 'common', label: '共用部設置' },
  { key: 'discard', label: '不良品処分' },
]

export const EQUIPMENT_REASON_LABELS = Object.fromEntries(
  [...EQUIPMENT_IN_REASONS, ...EQUIPMENT_OUT_REASONS, { key: 'tenant', label: 'テナント設置' }, { key: 'replace', label: '新規入替' }].map(
    (r) => [r.key, r.label]
  )
)

// ---- カテゴリ ----

export async function fetchEquipmentCategories() {
  const data = await authFetch('/api/equipment/categories')
  return data.categories || []
}

export async function saveEquipmentCategories(categories) {
  await authFetch('/api/equipment/categories', { method: 'PUT', body: JSON.stringify({ categories }) })
}

// ---- 備品マスタ・在庫 ----

export async function fetchEquipmentItems({ includeDisabled = false } = {}) {
  const qs = includeDisabled ? '?include_disabled=1' : ''
  const data = await authFetch(`/api/equipment/items${qs}`)
  return data.items || []
}

export async function createEquipmentItem(payload) {
  const data = await authFetch('/api/equipment/items', { method: 'POST', body: JSON.stringify(payload) })
  return data.item
}

export async function updateEquipmentItem(id, patch) {
  const data = await authFetch('/api/equipment/items', { method: 'PATCH', body: JSON.stringify({ id, ...patch }) })
  return data.item
}

export async function deleteEquipmentItem(id) {
  await authFetch(`/api/equipment/items?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ---- 入出庫 ----

// period: '3m' | '1y' | 'all'
export async function fetchEquipmentTransactions(itemNo, { period = '3m' } = {}) {
  const qs = new URLSearchParams({ item_no: String(itemNo), period })
  const data = await authFetch(`/api/equipment/transactions?${qs}`)
  return data
}

export async function createEquipmentTransaction(payload) {
  const data = await authFetch('/api/equipment/transactions', { method: 'POST', body: JSON.stringify(payload) })
  return data.transaction
}

export async function updateEquipmentTransaction(id, patch) {
  const data = await authFetch('/api/equipment/transactions', {
    method: 'PATCH',
    body: JSON.stringify({ id, ...patch }),
  })
  return data.transaction
}

export async function deleteEquipmentTransaction(id) {
  await authFetch(`/api/equipment/transactions?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// field: 'staff' | 'location' | 'supplier'
export async function fetchEquipmentSuggest(field) {
  const data = await authFetch(`/api/equipment/suggest?field=${encodeURIComponent(field)}`)
  return data.values || []
}
