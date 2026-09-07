import { authFetch } from './api'

// リマインダー（システム運用上の期限管理。2026-09-07〜）の API 呼び出しをまとめる。

export async function fetchReminders() {
  const data = await authFetch('/api/reminders')
  return data.reminders || []
}

export async function fetchReminder(id) {
  const data = await authFetch(`/api/reminders?id=${encodeURIComponent(id)}`)
  return data.reminder
}

export async function createReminder(payload) {
  const data = await authFetch('/api/reminders', { method: 'POST', body: JSON.stringify(payload) })
  return data.reminder
}

export async function updateReminder(id, patch) {
  const data = await authFetch('/api/reminders', { method: 'PATCH', body: JSON.stringify({ id, ...patch }) })
  return data.reminder
}

// 対応済み／未対応の切替だけを行う（一覧のボタンから使う軽量な操作）
export function setReminderDone(id, done) {
  return updateReminder(id, { done })
}

export async function deleteReminder(id) {
  await authFetch(`/api/reminders?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}
