import { authFetch } from './api'

// 廃棄物実測値管理（BKBビル・一般廃棄物。2026-09-03〜）の API 呼び出し・共通ユーティリティ。
// 詳細は docs/waste-plan.md 参照。

export const WASTE_FLOORS = ['1', '2', '3', '4', '5', '6', '7']

// 異常値の判定（3-3参照。自動修正はせず、一覧・確認画面での色分けにだけ使う）
export function classifyWasteWeight(weightKg) {
  const w = Number(weightKg)
  if (!Number.isFinite(w)) return 'normal'
  if (w >= 50) return 'extreme'
  if (w > 20) return 'high'
  return 'normal'
}

// 年度（4月始まり3月締め）。JSTの月から算出する
export function fiscalYearOf(month) {
  const [y, m] = month.split('-').map(Number)
  return m >= 4 ? y : y - 1
}

export function currentFiscalYear() {
  const now = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
  return fiscalYearOf(now.slice(0, 7))
}

// 年度内の月一覧（4月→翌3月の順）
export function fiscalYearMonths(fiscalYear) {
  const months = []
  for (let i = 0; i < 12; i++) {
    const m = ((3 + i) % 12) + 1
    const y = m >= 4 ? fiscalYear : fiscalYear + 1
    months.push(`${y}-${String(m).padStart(2, '0')}`)
  }
  return months
}

export async function fetchWasteRecords({ month, fiscalYear } = {}) {
  const params = new URLSearchParams()
  if (month) params.set('month', month)
  if (fiscalYear) params.set('fiscal_year', String(fiscalYear))
  const data = await authFetch(`/api/waste/records?${params.toString()}`)
  return data.records || []
}

export async function upsertWasteRecord(payload) {
  const data = await authFetch('/api/waste/records', { method: 'PUT', body: JSON.stringify(payload) })
  return data.record
}

export async function deleteWasteRecord(id) {
  await authFetch(`/api/waste/records?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function confirmWasteMonth(month) {
  await authFetch('/api/waste/records/confirm-month', { method: 'POST', body: JSON.stringify({ month }) })
}

// Excel取込（2026-09-09〜。src/lib/wasteExcelImport.js でブラウザ側にパース済みの
// 行データをまとめて送る。ファイル自体はサーバーへ送らない）
export async function importWasteRecords(rows) {
  const data = await authFetch('/api/waste/records/import', { method: 'POST', body: JSON.stringify({ rows }) })
  return { records: data.records || [], imported: data.imported || 0 }
}
