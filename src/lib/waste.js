import { authFetch } from './api'
import { getToken } from './auth'

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

// スキャン画像のアップロード（multipart/form-data。写真アップロードと同じくタイムアウトを設ける）
export async function uploadWasteScan({ targetMonth, file }) {
  const form = new FormData()
  form.append('target_month', targetMonth)
  form.append('file', file, file.name || 'scan.jpg')

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 45000)
  let res
  try {
    res = await fetch('/api/waste/scans', {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}` },
      body: form,
      signal: controller.signal,
    })
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('画像のアップロードがタイムアウトしました。通信環境をご確認のうえ再度お試しください。')
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || '画像の保存に失敗しました')
  return data.scan
}

export async function recognizeWasteScan(scanId) {
  const data = await authFetch('/api/waste/scans/recognize', {
    method: 'POST',
    body: JSON.stringify({ scan_id: scanId }),
  })
  return { records: data.records || [], readCount: data.read_count || 0 }
}
