import { authFetch } from './api'
import { getToken, logout } from './auth'

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

// Googleドライブからの取込（2026-09-30〜。docs/waste-plan.md 10-7）。
// 名前に「廃棄物」を含むスプレッドシートを更新日の新しい順に返す
export async function fetchWasteDriveFiles() {
  const data = await authFetch('/api/waste/drive-files')
  return data.files || []
}

// ドライブのファイルの中身を .xlsx（ArrayBuffer）で受け取る。Googleスプレッドシートは
// サーバー側で .xlsx に書き出されて返るので、そのまま parseWasteExcelBuffer で読める。
// バイナリを受け取るため authFetch（JSON前提）は使わず、401の扱いだけ揃える
export async function fetchWasteDriveFileBuffer(fileId) {
  const token = getToken()
  const res = await fetch(`/api/waste/drive-file?id=${encodeURIComponent(fileId)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (res.status === 401) {
    logout()
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.assign('/login?expired=1')
    }
    throw new Error('セッションの有効期限が切れました。再度ログインしてください。')
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `Googleドライブからの取得に失敗しました (${res.status})`)
  }
  return res.arrayBuffer()
}
