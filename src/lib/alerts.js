// 処理ログのステータス（I/W/E）と管理者通知（2026-11-25〜。worker/lib/alerts.js）
import { authFetch } from './api'

export const LEVEL_LABELS = {
  I: '情報',
  W: '警告',
  E: 'エラー',
}

// 未確認の警告・エラー件数。withUsers=true で通知先の候補（利用者と通知を受け取る端末の数）も返す
export async function fetchAdminAlerts({ withUsers = false } = {}) {
  return authFetch(`/api/admin-alerts${withUsers ? '?users=1' : ''}`)
}

export async function markAlertsSeen() {
  return authFetch('/api/admin-alerts/seen', { method: 'POST' })
}

export async function sendTestAlert() {
  return authFetch('/api/admin-alerts/test', { method: 'POST' })
}
