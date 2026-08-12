import { authFetch } from './api'
import { getToken } from './auth'

// 備品管理（Phase 1。2026-08-12〜）の API 呼び出し・共通定数をまとめる。
// docs/equipment-plan.md 参照。テナント設置・新規入替・署名は Phase 2 で追加する。

// 入庫理由（择一ボタンの選択肢。表示順）
export const EQUIPMENT_IN_REASONS = [
  { key: 'procure', label: '調達' },
  { key: 'deferred', label: '繰延登録' },
  { key: 'adjust', label: '在庫調整' },
]

// 出庫理由。replace（新規入替）はまだ未対応
export const EQUIPMENT_OUT_REASONS = [
  { key: 'tenant', label: 'テナント設置' },
  { key: 'common', label: '共用部設置' },
  { key: 'discard', label: '不良品処分' },
]

export const EQUIPMENT_REASON_LABELS = Object.fromEntries(
  [...EQUIPMENT_IN_REASONS, ...EQUIPMENT_OUT_REASONS, { key: 'replace', label: '新規入替' }].map((r) => [r.key, r.label])
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

// 全備品分の入出庫を備品IDごとにまとめて取得する（在庫一覧のその場展開表示用）。
// { transactionsByItem: { [item_id]: [...] } } を返す
export async function fetchEquipmentTransactionsAll({ period = '3m' } = {}) {
  const data = await authFetch(`/api/equipment/transactions?period=${encodeURIComponent(period)}`)
  return data.transactionsByItem || {}
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

// ---- テナント ----

export async function fetchEquipmentTenants({ includeMovedOut = false } = {}) {
  const qs = includeMovedOut ? '?include_moved_out=1' : ''
  const data = await authFetch(`/api/equipment/tenants${qs}`)
  return data.tenants || []
}

// ---- 署名（5-5） ----

// txnId の入出庫レコードに署名PNGを登録する（保存と同時・後付けの両方でこの1本を使う）。
// multipart なので authFetch は使わない（Content-Type はブラウザに境界線付きで
// 設定させる必要がある。uploadPhoto と同じ理由。src/lib/reports.js 参照）
export async function uploadEquipmentSignature(txnId, blob) {
  const form = new FormData()
  form.append('txn_id', txnId)
  form.append('file', blob, 'signature.png')
  const res = await fetch('/api/equipment/signature', {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body: form,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || '署名の登録に失敗しました')
  return data.transaction
}

// 署名画像の表示用URL（<img>のsrcにそのまま使う。Blob化はコンポーネント側の必要に応じて）
export function equipmentSignatureUrl(txnId) {
  return `/api/equipment/signature?txn_id=${encodeURIComponent(txnId)}`
}
