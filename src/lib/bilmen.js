import { authFetch } from './api'

// ビルメンテナンス管理（ビルメン。Phase 1。2026-09-02〜）の API 呼び出し・共通ユーティリティ。
// 現行 FileMaker「BKB-Mgt / 作業管理」の移行。詳細は docs/bilmen-plan.md 参照。

// 管轄は2値（作業マスタ詳細ではラジオボタン。bilmen-plan 2-7）
export const BILMEN_JURISDICTIONS = ['栄和', '小泉産業']

// ---- 作業マスタ ----

export async function fetchBilmenMasters({ includeDisabled = false } = {}) {
  const qs = includeDisabled ? '?include_disabled=1' : ''
  const data = await authFetch(`/api/bilmen/masters${qs}`)
  return data.masters || []
}

export async function createBilmenMaster(payload) {
  const data = await authFetch('/api/bilmen/masters', { method: 'POST', body: JSON.stringify(payload) })
  return data.master
}

export async function updateBilmenMaster(id, patch) {
  const data = await authFetch('/api/bilmen/masters', { method: 'PATCH', body: JSON.stringify({ id, ...patch }) })
  return data.master
}

export async function deleteBilmenMaster(id) {
  await authFetch(`/api/bilmen/masters?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// 表示順を10刻みに振り直す（現行の「表示順を再採番」ボタン）。{ updated } を返す
export async function renumberBilmenMasters() {
  return authFetch('/api/bilmen/masters/renumber', { method: 'POST' })
}

// ---- メンテナンス予定・実績 ----

export async function fetchBilmenSchedules({ month, months, q } = {}) {
  const params = new URLSearchParams()
  if (month) params.set('month', month)
  if (months) params.set('months', String(months))
  if (q) params.set('q', q)
  const qs = params.toString()
  const data = await authFetch(`/api/bilmen/schedules${qs ? `?${qs}` : ''}`)
  return data.schedules || []
}

export async function createBilmenSchedule(payload) {
  const data = await authFetch('/api/bilmen/schedules', { method: 'POST', body: JSON.stringify(payload) })
  return data.schedule
}

// patch に full:true を入れると詳細モーダルからの全項目保存、入れなければ
// 一覧のその場編集（送った列だけの部分更新）になる（worker/lib/bilmen.js 参照）
export async function updateBilmenSchedule(id, patch) {
  const data = await authFetch('/api/bilmen/schedules', { method: 'PATCH', body: JSON.stringify({ id, ...patch }) })
  return data.schedule
}

export async function deleteBilmenSchedule(id) {
  await authFetch(`/api/bilmen/schedules?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// 自動作成の候補（対象月を実施月に含む有効なマスタ。作成済みは created:true）
export async function fetchBilmenGenerateCandidates(month) {
  const data = await authFetch(`/api/bilmen/schedules/generate?month=${encodeURIComponent(month)}`)
  return data.candidates || []
}

// 予定の自動作成。{ created, skipped } を返す
export async function generateBilmenSchedules(month, masterIds) {
  return authFetch('/api/bilmen/schedules/generate', {
    method: 'POST',
    body: JSON.stringify({ month, master_ids: masterIds }),
  })
}

// ---- メール設定（文面・宛先） ----
// 画面（/bilmen/mail）自体を owner・備品出庫限定ロールには出さない（AppHeader・App.jsx側）が、
// API 側でも同じ判定で塞いである（worker/lib/bilmen.js の requireMailAccess）。

export async function fetchBilmenMailSettings() {
  const data = await authFetch('/api/bilmen/mail/settings')
  return data.settings
}

export async function updateBilmenMailSettings(patch) {
  const data = await authFetch('/api/bilmen/mail/settings', { method: 'PUT', body: JSON.stringify(patch) })
  return data.settings
}

export async function fetchBilmenMailRecipients() {
  const data = await authFetch('/api/bilmen/mail/recipients')
  return data.recipients || []
}

export async function createBilmenMailRecipient(payload) {
  const data = await authFetch('/api/bilmen/mail/recipients', { method: 'POST', body: JSON.stringify(payload) })
  return data.recipient
}

export async function updateBilmenMailRecipient(id, patch) {
  const data = await authFetch('/api/bilmen/mail/recipients', { method: 'PATCH', body: JSON.stringify({ id, ...patch }) })
  return data.recipient
}

export async function deleteBilmenMailRecipient(id) {
  await authFetch(`/api/bilmen/mail/recipients?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// 建物名（13-4。1棟のみで確定のため settings テーブルには持たせず、帳票・メールの
// 3箇所で共通して使うここに定数として置く）
export const BILMEN_BUILDING_NAME = '備後町コイズミビル'

// 掲示・案内メールの対象＝報知対象☑ かつ 予定日付あり かつ 中止でない行（3-4・8-1）。
// PDF・メール送信のどちらからも同じ条件で数えられるよう共通化する
export function notifyTargets(schedules) {
  return schedules.filter((s) => s.notify && s.plan_date && !s.canceled)
}

// メール本文・件名の変数展開（4-2）。%今月の注釈% は今月の注釈機能が未実装のため
// 対応する変数を用意していない（Phase 2 追加分）
export function expandMailVariables(text, { month, count }) {
  return (text || '')
    .replaceAll('%対象年月%', `${month.replace('-', '年')}月度`)
    .replaceAll('%建物名%', BILMEN_BUILDING_NAME)
    .replaceAll('%作業件数%', String(count))
}

// mailto: リンクの組み立て（3-5・7-3 方式B）。宛先は BCC にまとめ、TO は空欄にする
// （共有アドレス自身が送信元になるため。src/lib/mail.js の buildReplyMailto と同じ考え方）
export function buildBilmenNoticeMailto(subject, body, recipientEmails) {
  const bcc = recipientEmails.join(',')
  const params = new URLSearchParams({ subject, body })
  if (bcc) params.set('bcc', bcc)
  return `mailto:?${params.toString().replace(/\+/g, '%20')}`
}

// ---- 表示用のユーティリティ ----

// 実施月の配列を現行表記（'1, 3, 5, 7, 9, 11'）にする。空なら「随時」
export function formatMonths(months) {
  if (!Array.isArray(months) || months.length === 0) return '随時'
  return months.join(', ')
}

// 予定日付を 'mm/dd' にする（一覧・PDFの年月ヘッダで年は分かるため年を出さない。修正依頼）
export function formatMonthDay(date) {
  if (!date) return ''
  return date.slice(5).replace('-', '/')
}

// time 型（'09:10:00' / '09:10'）を 'HH:MM' にそろえる。TimeInput の value に渡す形
export function toTimeValue(value) {
  return typeof value === 'string' && value.length >= 5 ? value.slice(0, 5) : ''
}

// 予定時刻の範囲表示（'09:10 〜 09:30'）。片方だけでも読めるようにする
export function formatTimeRange(start, end) {
  const s = toTimeValue(start)
  const e = toTimeValue(end)
  if (!s && !e) return ''
  return `${s || '--:--'} 〜 ${e || '--:--'}`
}

// 実績日時の表示（'2026/09/01 09:10'）。日付が無ければ空
export function formatActual(date, start) {
  if (!date) return ''
  const time = toTimeValue(start)
  return time ? `${date.replaceAll('-', '/')} ${time}` : date.replaceAll('-', '/')
}

// 「確定作業が残っている」行か（5-3）。予定日付・作業IDのどちらかが未入力なら未確定として扱い、
// 月グループの先頭に「未確定」小見出しでまとめる
export function isUnsettled(schedule) {
  return !schedule.plan_date || !schedule.work_no
}

// 「予定通り ➡」を催促表示（オレンジ）にするか（2-1）。
// 予定日を過ぎているのに実績日付が空の行だけを目立たせる。中止の行は対象外
export function isOverdueActual(schedule, today) {
  if (schedule.canceled || schedule.actual_date) return false
  return Boolean(schedule.plan_date) && schedule.plan_date < today
}
