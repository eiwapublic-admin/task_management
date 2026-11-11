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
// 行データをまとめて送る。ファイル自体はサーバーへ送らない）。
// month を渡すと、その月の未確認の下書きのうちファイルに無いマスはサーバー側で削除される
// （前回取り込んだ誤ったファイルの値を残さないため。2026-09-30〜）
export async function importWasteRecords(rows, month) {
  const data = await authFetch('/api/waste/records/import', {
    method: 'POST',
    body: JSON.stringify({ rows, month }),
  })
  return { records: data.records || [], imported: data.imported || 0, removed: data.removed || 0 }
}

// 手書きの集計表の写真をAIで読み取る（2026-11-11〜。docs/waste-plan.md 10-10）。
// 保存はせず、日ごとの { day, floors: {'1'..'7': kg|null}, total: kg|null, unclear: [] } を返す。
// 画像はJSONに包まず、そのまま本文として送る（Worker側のCPU時間の節約）
export async function recognizeWastePhoto(blob, month) {
  const data = await authFetch(`/api/waste/photo/recognize?month=${encodeURIComponent(month)}`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'image/jpeg' },
    body: blob,
  })
  return data.rows || []
}

// 手書きの「合計」欄と、各階の和の差がこれ以下なら一致とみなす（合計欄を小数1桁で
// 丸めて書くことがあるため。例: 8.17 → 8.2）
export const WASTE_TOTAL_TOLERANCE = 0.05

// 読み取り結果1行の各階の和（値が1つも無ければ null）
export function wastePhotoRowSum(floors) {
  let sum = 0
  let any = false
  for (const f of WASTE_FLOORS) {
    const v = floors?.[f]
    if (v === null || v === undefined || v === '') continue
    const n = Number(v)
    if (!Number.isFinite(n)) continue
    sum += n
    any = true
  }
  return any ? Math.round(sum * 100) / 100 : null
}

// 合計欄との突き合わせ。'ok' | 'mismatch' | 'none'（どちらかが空で比べられない）
export function wastePhotoRowCheck(floors, total) {
  const sum = wastePhotoRowSum(floors)
  const t = total === null || total === undefined || total === '' ? null : Number(total)
  if (t === null || !Number.isFinite(t)) return 'none'
  if (sum === null) return t === 0 ? 'none' : 'mismatch'
  return Math.abs(sum - t) <= WASTE_TOTAL_TOLERANCE + 1e-9 ? 'ok' : 'mismatch'
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
