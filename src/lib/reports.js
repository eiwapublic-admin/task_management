// 日報機能のフロントエンド API クライアント（2026-08-04〜）。
// タスク管理側の src/lib/tasks.js と同じく authFetch（Bearer 付き）経由で Worker を呼ぶ。

import { authFetch } from './api'

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

// 現在時刻（JST）を 'HH:MM' で返す。作業記録の追加時に既定値として使う
export function nowHHMM() {
  return new Date().toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}
