import { authFetch } from './api'

// 古紙回収量の記録（備後町コイズミビル＝BKB。2026-09-08〜）の API 呼び出しと共通処理。
// 従来のExcel（年度ごとのシート・毎週月曜の行）と同じ見え方になるよう、回収予定日は
// DBに持たず「年度内の月曜」を画面側で自動生成し、入力のあった回だけをDBに保存する。

// 計量する区分。並び順はExcelの列順に合わせる
export const PAPER_CATEGORIES = [
  { key: 'cardboard_kg', label: '段ボール' },
  { key: 'shredder_kg', label: 'シュレッダ' },
  { key: 'magazine_kg', label: '雑誌' },
  { key: 'other_kg', label: 'その他' },
]

// 回収日の曜日（0=日曜〜6=土曜）。既定は月曜。祝日・休館日に当たった週は
// 中止（skipped）にするか、日程変更を備考に書く運用（依頼元の運用に合わせる）
export const PAPER_COLLECT_WEEKDAY = 1

// 年度（4月始まり3月締め）。'YYYY-MM' から算出する
export function fiscalYearOf(month) {
  const [y, m] = month.split('-').map(Number)
  return m >= 4 ? y : y - 1
}

export function currentFiscalYear() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
  return fiscalYearOf(today.slice(0, 7))
}

// 年度内の回収予定日（既定は毎週月曜）を古い順に並べて返す。
// UTCの日付演算だけで求めるため実行環境のタイムゾーンに依存しない。
export function collectDatesOfFiscalYear(fiscalYear, weekday = PAPER_COLLECT_WEEKDAY) {
  const start = new Date(Date.UTC(fiscalYear, 3, 1)) // 4/1
  const end = new Date(Date.UTC(fiscalYear + 1, 2, 31)) // 翌3/31
  // 年度開始日以降で最初に該当曜日が来る日まで進める
  const shift = (weekday - start.getUTCDay() + 7) % 7
  start.setUTCDate(start.getUTCDate() + shift)

  const dates = []
  for (let d = start; d <= end; d.setUTCDate(d.getUTCDate() + 7)) {
    dates.push(d.toISOString().slice(0, 10))
  }
  return dates
}

// 1回分の合計（未入力の区分は0として扱う。中止の回は合計を出さない）
export function paperRowTotal(record) {
  if (!record || record.skipped) return 0
  return PAPER_CATEGORIES.reduce((sum, c) => sum + Number(record[c.key] || 0), 0)
}

// 表示用の丸め。整数はそのまま、小数がある場合だけ小数第1位まで出す
export function formatKg(value) {
  const num = Number(value || 0)
  if (!Number.isFinite(num)) return ''
  return Number.isInteger(num) ? String(num) : num.toFixed(1)
}

export async function fetchPaperRecords(fiscalYear) {
  const data = await authFetch(`/api/paper/records?fiscal_year=${encodeURIComponent(fiscalYear)}`)
  return data.records || []
}

export async function upsertPaperRecord(payload) {
  const data = await authFetch('/api/paper/records', { method: 'PUT', body: JSON.stringify(payload) })
  return data.record
}

export async function deletePaperRecord(id) {
  await authFetch(`/api/paper/records?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}
