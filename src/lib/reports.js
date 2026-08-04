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


export async function fetchPhotos(reportId) {
  const data = await authFetch(`/api/report/photos?report_id=${encodeURIComponent(reportId)}`)
  return data.photos || []
}

// 写真のアップロード。縮小は呼び出し側（imageResize.prepareImage）で済ませてから渡す。
// FormData を送るため authFetch は使わず、ここで Bearer を付ける
// （authFetch は Content-Type: application/json を付けてしまうため）。
export async function uploadPhoto({ reportId, category, file, thumb, filename, width, height, takenAt, comment }) {
  const form = new FormData()
  form.append('report_id', reportId)
  form.append('category', category || 'work')
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
