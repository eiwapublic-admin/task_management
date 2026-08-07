// 日報機能のフロントエンド API クライアント（2026-08-04〜）。
// タスク管理側の src/lib/tasks.js と同じく authFetch（Bearer 付き）経由で Worker を呼ぶ。

import { authFetch } from './api'
import { getToken } from './auth'

// 日報一覧（日付の新しい順。作業記録の抜粋つき）
export async function fetchReports() {
  const data = await authFetch('/api/reports')
  return data.reports || []
}

// 指定日の日報1件。未作成の日は null が返る
export async function fetchReport(date) {
  const data = await authFetch(`/api/report?date=${encodeURIComponent(date)}`)
  return data.report || null
}

// 指定日の日報を作成する（既にあればそれが返る）
export async function createReport(date, fields = {}) {
  const data = await authFetch('/api/report', {
    method: 'POST',
    body: JSON.stringify({ report_date: date, ...fields }),
  })
  return data.report
}

// 日報ヘッダ（作業者・作業時間）の更新
export async function updateReport(id, patch) {
  const data = await authFetch('/api/report', {
    method: 'PATCH',
    body: JSON.stringify({ id, ...patch }),
  })
  return data.report
}

// 日報1件の削除（明細・写真・違反車両もまとめて消える）
export async function deleteReport(id) {
  await authFetch(`/api/report?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// 作業記録の追加。タスクからの転記は source_task_id を渡す
export async function addEntry(reportId, fields = {}) {
  const data = await authFetch('/api/report/entries', {
    method: 'POST',
    body: JSON.stringify({ report_id: reportId, ...fields }),
  })
  return data.entry
}

export async function updateEntry(id, patch) {
  const data = await authFetch('/api/report/entries', {
    method: 'PATCH',
    body: JSON.stringify({ id, ...patch }),
  })
  return data.entry
}

export async function deleteEntry(id) {
  await authFetch(`/api/report/entries?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// 定型文（ルーチン業務の文言）
export async function fetchTemplates() {
  const data = await authFetch('/api/report/templates')
  return data.templates || []
}

export async function saveTemplates(labels) {
  return authFetch('/api/report/templates', {
    method: 'PUT',
    body: JSON.stringify({ labels }),
  })
}

// 'YYYY-MM-DD'（JST基準の今日）
export function todayJST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
}

// 'YYYY-MM-DD' を n 日ずらす（前日/翌日の移動に使う）
export function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// 'YYYY-MM-DD' → '2026/08/04 (火)'
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']
export function formatReportDate(date) {
  if (!date) return ''
  const d = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return date
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(
    d.getUTCDate()
  ).padStart(2, '0')} (${WEEKDAYS[d.getUTCDay()]})`
}

// 'HH:MM:SS' → 'HH:MM'（input[type=time] と表示で使う）
export function toHHMM(value) {
  if (typeof value !== 'string') return ''
  const m = /^(\d{2}):(\d{2})/.exec(value)
  return m ? `${m[1]}:${m[2]}` : ''
}

// 現在時刻（JST）を 'HH:MM' で返す。
// ※ 作業記録の時刻の既定値としては使わない（2026-08-04。後からまとめて入力する運用で
//    実際の作業時刻と食い違うため空欄にした）。撮影時刻の補完など別用途で使う想定。
export function nowHHMM() {
  return new Date().toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

// ---- 写真（Phase 2。2026-08-04〜）----


// category を指定すると絞り込む（work=作業記録の写真 / parking=違反車両の写真。混在させないため）
export async function fetchPhotos(reportId, category) {
  const qs = new URLSearchParams({ report_id: reportId })
  if (category) qs.set('category', category)
  const data = await authFetch(`/api/report/photos?${qs}`)
  return data.photos || []
}

// 写真のアップロード。縮小は呼び出し側（imageResize.prepareImage）で済ませてから渡す。
// FormData を送るため authFetch は使わず、ここで Bearer を付ける
// （authFetch は Content-Type: application/json を付けてしまうため）。
export async function uploadPhoto({
  reportId,
  category,
  parkingId,
  file,
  thumb,
  filename,
  width,
  height,
  takenAt,
  comment,
}) {
  const form = new FormData()
  form.append('report_id', reportId)
  form.append('category', category || 'work')
  if (parkingId) form.append('parking_id', parkingId)
  form.append('file', file, filename || 'photo.jpg')
  if (thumb) form.append('thumb', thumb, 'thumb.jpg')
  if (filename) form.append('filename', filename)
  if (width) form.append('width', String(width))
  if (height) form.append('height', String(height))
  if (takenAt) form.append('taken_at', takenAt)
  if (comment) form.append('comment', comment)

  const res = await fetch('/api/report/photos', {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body: form,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || '写真の保存に失敗しました')
  return data.photo
}

export async function updatePhotoComment(id, comment) {
  const data = await authFetch('/api/report/photos', {
    method: 'PATCH',
    body: JSON.stringify({ id, comment }),
  })
  return data.photo
}

export async function deletePhoto(id) {
  await authFetch(`/api/report/photos?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// 写真の本体を取得して Blob URL を作る。バケットは非公開なので必ずこの経路を通す。
// 呼び出し側は使い終わったら URL.revokeObjectURL で解放すること。
export async function fetchPhotoObjectUrl(id, { thumb = false } = {}) {
  const res = await fetch(`/api/report/photo?id=${encodeURIComponent(id)}${thumb ? '&thumb=1' : ''}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  })
  if (!res.ok) throw new Error('写真を取得できませんでした')
  return URL.createObjectURL(await res.blob())
}

// ストレージ使用量（「従量課金事項」画面で表示する）
export async function fetchStorageUsage() {
  return authFetch('/api/report/storage')
}

// ---- 自主検査表（Phase 3。2026-08-04〜）----

// 紙の様式に並ぶ検査項目（順序も紙に合わせる）。判定は ok=良 / ng=不良 / fixed=即時改修。
// 「避難通路」「喫煙場所」は紙でも2行あるため、キーだけ分けて表示名は同じにする。
export const INSPECTION_ITEMS = [
  { key: '防火区画', label: '防火区画', group: '防火管理・避難管理' },
  { key: '避難通路1', label: '避難通路', group: '防火管理・避難管理' },
  { key: '避難通路2', label: '避難通路', group: '防火管理・避難管理' },
  { key: '通路非常照明', label: '通路非常照明', group: '防火管理・避難管理' },
  { key: '階段・防火戸', label: '階段・防火戸', group: '防火管理・避難管理' },
  { key: '階段非常照明', label: '階段非常照明', group: '防火管理・避難管理' },
  { key: '非常用進入口', label: '非常用進入口', group: '防火管理・避難管理' },
  { key: 'カーテンじゅうたん等', label: 'カーテンじゅうたん等', group: '防火・火気使用・電気器具・喫煙' },
  { key: '喫煙場所1', label: '喫煙場所', group: '防火・火気使用・電気器具・喫煙' },
  { key: 'フード・ダクト', label: 'フード・ダクト', group: '防火・火気使用・電気器具・喫煙' },
  { key: 'ガス設備・器具', label: 'ガス設備・器具', group: '防火・火気使用・電気器具・喫煙' },
  { key: '喫煙場所2', label: '喫煙場所', group: '防火・火気使用・電気器具・喫煙' },
  { key: '危険物等', label: '危険物等', group: '防火・火気使用・電気器具・喫煙' },
  { key: '消防用設備', label: '消防用設備', group: '防火・火気使用・電気器具・喫煙' },
]

// 対象のビル。BKB＝備後町コイズミビルの略称
export const INSPECTION_BUILDINGS = ['BKB', '小泉本社']

// 紙の凡例に対応する表示記号
export const JUDGEMENT_MARKS = { ok: '○', ng: '×', fixed: '◎' }
export const JUDGEMENT_LABELS = { ok: '良', ng: '不良', fixed: '即時改修' }

export async function fetchInspections({ month, date } = {}) {
  const qs = new URLSearchParams()
  if (month) qs.set('month', month)
  if (date) qs.set('date', date)
  const suffix = qs.toString() ? `?${qs}` : ''
  const data = await authFetch(`/api/report/inspections${suffix}`)
  return data.inspections || []
}

export async function saveInspection(payload) {
  const data = await authFetch('/api/report/inspections', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return data.inspection
}

export async function deleteInspection(id) {
  await authFetch(`/api/report/inspections?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// 自主検査表PDFをアプリ内プレビュー表示するための短時間有効URLを発行する
// （プロジェクトスキル print-and-pdf-download Gotcha 8）。iOS Safariのホーム画面追加
// アプリ（standalone表示）は pdf.save() の download 属性を無視してそのままナビゲート
// してしまい、「×」で閉じても戻り先が無く画面が真っ白になる。既存の添付ファイル
// プレビュー（getAttachmentPreviewUrl）と同じ「実URLへの<iframe>ナビゲーション」方式
// にすることで、共有シートも画面遷移も発生させずアプリ内で開いて×で戻れるようにする。
export async function getInspectionPdfPreviewUrl(pdfBlob, filename) {
  const { token } = await authFetch('/api/report/inspection-pdf-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: pdfBlob,
  })
  const params = new URLSearchParams({ token, filename: filename || 'inspection.pdf' })
  return `/api/report/inspection-pdf-preview?${params.toString()}`
}

// 日本の祝日一覧（{日付: 祝日名}）。日付列の色分けに使う。
export async function fetchHolidays() {
  const data = await authFetch('/api/report/holidays')
  return data.holidays || {}
}

// 休館日（2026-08-07〜。自主検査表・日報一覧の両方から参照・登録するプロジェクト共通情報）。
// month を省略すると全期間を返す。
export async function fetchClosedDays({ month } = {}) {
  const qs = month ? `?month=${encodeURIComponent(month)}` : ''
  const data = await authFetch(`/api/report/closed-days${qs}`)
  return data.closed_days || []
}

export async function markClosedDay(date) {
  return authFetch('/api/report/closed-days', {
    method: 'POST',
    body: JSON.stringify({ date }),
  })
}

export async function unmarkClosedDay(date) {
  await authFetch(`/api/report/closed-days?date=${encodeURIComponent(date)}`, { method: 'DELETE' })
}

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土']

// 'YYYY-MM-DD' の曜日情報を返す。土曜=青、日曜・祝日=赤（2026-08-05）。
export function weekdayInfo(date, holidays = {}) {
  const d = new Date(`${date}T00:00:00Z`)
  const dow = d.getUTCDay()
  const holidayName = holidays[date] || null
  const isRed = dow === 0 || Boolean(holidayName)
  const isBlue = dow === 6 && !holidayName
  return {
    label: WEEKDAY_LABELS[dow],
    holidayName,
    className: isRed ? 'is-holiday' : isBlue ? 'is-saturday' : '',
  }
}

// 'YYYY-MM'（JST基準の当月）
export function currentMonthJST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' }).slice(0, 7)
}

// 'YYYY-MM' を n か月ずらす
export function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

// 'YYYY-MM' の日数
export function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

// 自主検査表（紙の様式）の「実施日時」の列数。PDFはこの列数＝半月で1ページに分ける
export const INSPECTION_SHEET_COLUMNS = 16

// 半月ごとの日付リスト（前半＝1〜16日、後半＝17日〜末日）。
// 後半が16日に満たない月（2月など）は、PDF側で残りの列を空欄のまま並べる
export function halfMonthRanges(month, dayCount) {
  const build = (from, to) => {
    const days = []
    for (let d = from; d <= to; d += 1) days.push(`${month}-${String(d).padStart(2, '0')}`)
    return { from, to, days }
  }
  const half = INSPECTION_SHEET_COLUMNS
  return [build(1, Math.min(half, dayCount)), build(half + 1, dayCount)]
}

// ---- 不正駐車（Phase 4。2026-08-05〜）----

export const VIOLATION_LABELS = {
  unrecorded: '無断駐車',
  false_entry: '虚偽記入',
  long_stay: '長時間駐車',
  after_hours: '時間外駐車',
  other: 'その他',
}

// reportId を指定すればその日だけ、省略すれば全期間（違反車両一覧画面用）
export async function fetchParkingViolations({ reportId } = {}) {
  const qs = reportId ? `?report_id=${encodeURIComponent(reportId)}` : ''
  const data = await authFetch(`/api/report/parking${qs}`)
  return data.violations || []
}

export async function createParkingViolation(payload) {
  const data = await authFetch('/api/report/parking', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return data.violation
}

export async function updateParkingViolation(id, patch) {
  const data = await authFetch('/api/report/parking', {
    method: 'PATCH',
    body: JSON.stringify({ id, ...patch }),
  })
  return data.violation
}

export async function deleteParkingViolation(id) {
  await authFetch(`/api/report/parking?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// 写真からナンバープレート・車種を読み取る（手動トリガー。2026-08-05〜）。
// 読み取れなかった項目は null で返る（呼び出し側は空欄のままにする）。
export async function recognizeParkingPhoto(photoId) {
  return authFetch('/api/report/parking/recognize', {
    method: 'POST',
    body: JSON.stringify({ photo_id: photoId }),
  })
}
