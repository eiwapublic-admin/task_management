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

// timestamptz（ISO文字列）→ JST の 'YYYY-MM-DD'。
// 測定日時・確認日時のように時刻を持つ値を「その日」として扱いたいときに使う。
// ISO文字列をそのまま slice(0, 10) すると UTC 基準になり、JSTの夕方以降が前日に
// ずれてしまうため、必ずこの関数を通す（2026-08-12に違反車両一覧から共通化）。
export function jstDateOnly(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
}

// timestamptz（ISO文字列）→ JST の 'HH:MM'。jstDateOnly の時刻版（2026-08-19。
// 違反車両の更新画面で日付だけでなく時刻も訂正できるようにするため追加）
export function jstTimeOnly(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

// 作業記録を時刻順に並べる（保存順＝sort_order とは独立）。時刻が同じ／未入力のものは
// 追加順を保つため sort_order をタイブレークに使う。日報詳細と一覧（リスト型・カレンダー型）
// で並び順が食い違わないよう、両方からこの関数を使う（2026-08-07）。
export function sortEntriesByTime(entries) {
  return [...entries].sort((a, b) => {
    const at = a.entry_time || '99:99:99'
    const bt = b.entry_time || '99:99:99'
    if (at !== bt) return at < bt ? -1 : 1
    return a.sort_order - b.sort_order
  })
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


// category を指定すると絞り込む（work=作業記録の写真 / parking=違反車両の写真 /
// chlorine=残留塩素等検査の写真。混在させないため）
export async function fetchPhotos(reportId, category) {
  const qs = new URLSearchParams({ report_id: reportId })
  if (category) qs.set('category', category)
  const data = await authFetch(`/api/report/photos?${qs}`)
  return data.photos || []
}

// 残留塩素等検査の写真は日報単位ではなく検査レコード単位で扱う（2026-08-10）
export async function fetchChlorinePhotos(chlorineId) {
  const qs = new URLSearchParams({ chlorine_id: chlorineId, category: 'chlorine' })
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
  chlorineId,
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
  if (chlorineId) form.append('chlorine_id', chlorineId)
  form.append('file', file, filename || 'photo.jpg')
  if (thumb) form.append('thumb', thumb, 'thumb.jpg')
  if (filename) form.append('filename', filename)
  if (width) form.append('width', String(width))
  if (height) form.append('height', String(height))
  if (takenAt) form.append('taken_at', takenAt)
  if (comment) form.append('comment', comment)

  // アップロード中に通信が切れる/固まると、呼び出し元（ChlorineForm等）の「保存中…」が
  // 画面上いつまでも動かないまま止まって見える不具合があった（2026-08-13。残留塩素の
  // 追加登録で写真付きの2件目を保存した際に発生・報告）。fetch自体には既定のタイムアウトが
  // 無いため、45秒で打ち切って明確なエラーにする（再試行できるようにするため）
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 45000)
  let res
  try {
    res = await fetch('/api/report/photos', {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}` },
      body: form,
      signal: controller.signal,
    })
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('写真のアップロードがタイムアウトしました。通信環境をご確認のうえ再度お試しください。')
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
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

// 日報系で生成したPDFをアプリ内プレビュー表示するための短時間有効URLを発行する
// （プロジェクトスキル print-and-pdf-download Gotcha 8）。iOS Safariのホーム画面追加
// アプリ（standalone表示）は pdf.save() の download 属性を無視してそのままナビゲート
// してしまい、「×」で閉じても戻り先が無く画面が真っ白になる。既存の添付ファイル
// プレビュー（getAttachmentPreviewUrl）と同じ「実URLへの<iframe>ナビゲーション」方式
// にすることで、共有シートも画面遷移も発生させずアプリ内で開いて×で戻れるようにする。
// APIパスは自主検査表PDF用に作ったものをそのまま使う（保存内容はPDF本体だけで
// 種類を問わないため。残留塩素等検査の帳票PDFも同じ経路を通す。2026-08-10）。
//
// kind: 'inspection' | 'chlorine'。保存先はユーザーごとに固定キー（upsert）だが、
// 種類ごとに別キーへ分ける（2026-08-10）。以前は種類を問わず同じキーを共有していたため、
// 片方のPDF生成がまだバックグラウンドで完了していない間にもう片方を生成すると、
// 後から書き込まれた方が勝ってしまい「違う種類の帳票が表示される」ことがあった。
export async function getReportPdfPreviewUrl(pdfBlob, filename, kind) {
  const { token } = await authFetch(`/api/report/inspection-pdf-preview?kind=${encodeURIComponent(kind)}`, {
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

// ナンバーは数字4桁のみを保持する（「-」等の区切り文字は除去。2026-08-05）。
// ReportParkingViolations.jsx・ParkingViolationDetail.jsx の両方で使う入力規則
export function sanitizePlateNumber(value) {
  return (value || '').replace(/\D/g, '').slice(0, 4)
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

// ---- 残留塩素等検査（Phase 5。2026-08-10）----

// 測定施設。BKB＝備後町コイズミビルの略称。
// 2026-08-10時点では「実際に測定するのはBKB・小泉本社の2施設のみ」との確認により
// スイングビルを対象外にしていたが、FileMaker側では直近まで継続してスイングビルの
// 測定記録が入力されていたことが移行時（2026-08-25）に判明し、3施設目として追加した
export const CHLORINE_BUILDINGS = ['BKB', '小泉本社', 'スイングビル']

// 帳票・入力欄に並ぶ官能検査の4項目（順序も紙の帳票に合わせる）
export const CHLORINE_JUDGEMENT_ITEMS = [
  { key: 'color_ok', label: '色' },
  { key: 'turbidity_ok', label: '濁り' },
  { key: 'odor_ok', label: '臭気' },
  { key: 'taste_ok', label: '味' },
]

// 水道水質基準（帳票の見出しに印字する）。遊離残留塩素として 0.1mg/L 以上
export const CHLORINE_STANDARD_MIN = 0.1

// 濃度入力欄の候補値（リスト選択のみ。2026-08-10。2026-08-18に自由入力欄を廃止しリスト選択のみにした際、
// 先頭に「0」を追加した）
export const CHLORINE_CONCENTRATION_OPTIONS = ['0', '0.05', '0.10', '0.20', '0.30', '0.40', '0.50']

// year（'YYYY'）・building・reportId を省略すると全期間・全施設を返す。
// reportId は日報詳細からの「残留塩素」ボタン（2026-08-10）で、その日の記録有無を見るために使う
export async function fetchChlorineTests({ year, building, reportId } = {}) {
  const qs = new URLSearchParams()
  if (year) qs.set('year', String(year))
  if (building) qs.set('building', building)
  if (reportId) qs.set('report_id', reportId)
  const suffix = qs.toString() ? `?${qs}` : ''
  const data = await authFetch(`/api/report/chlorine${suffix}`)
  return data.tests || []
}

// 測定日（tested_at のJST日付）の日報はサーバー側で引き当て/作成される
export async function createChlorineTest(payload) {
  const data = await authFetch('/api/report/chlorine', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return data.test
}

export async function updateChlorineTest(id, patch) {
  const data = await authFetch('/api/report/chlorine', {
    method: 'PATCH',
    body: JSON.stringify({ id, ...patch }),
  })
  return data.test
}

export async function deleteChlorineTest(id) {
  await authFetch(`/api/report/chlorine?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// 'YYYY'（JST基準の今年）
export function currentYearJST() {
  return Number(todayJST().slice(0, 4))
}

// ISO文字列 → <input type="datetime-local"> 用の 'YYYY-MM-DDTHH:MM'（端末のローカル時刻）
export function toDateTimeLocal(value) {
  const d = value ? new Date(value) : new Date()
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 濃度の表示（0.10 のように小数第2位で揃える）。未測定は空文字
export function formatConcentration(value) {
  if (value === null || value === undefined || value === '') return ''
  const num = Number(value)
  return Number.isFinite(num) ? num.toFixed(2) : ''
}
