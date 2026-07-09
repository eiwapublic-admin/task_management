import { getToken } from './auth'

// Worker の API（/api/*）への認証付きリクエスト用ヘルパー。
async function authFetch(path, options = {}) {
  const token = getToken()
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `リクエストに失敗しました (${res.status})`)
  }
  return data
}

// メールの手動取得を実行する（/api/run-fetch）。取得・分類の集計を返す。
export function runFetch() {
  return authFetch('/api/run-fetch', { method: 'POST' })
}

// 設定を保存する（/api/settings）。
export function saveSettings(values) {
  return authFetch('/api/settings', { method: 'PUT', body: JSON.stringify(values) })
}

// タスクを手動で新規登録する（/api/tasks）。作成したタスクを返す。
export function createTask(values) {
  return authFetch('/api/tasks', { method: 'POST', body: JSON.stringify(values) })
}

// タスクの担当者・期限・留意事項などを更新する（/api/tasks）。更新後のタスクを返す。
export function updateTask(id, values) {
  return authFetch('/api/tasks', { method: 'PATCH', body: JSON.stringify({ id, ...values }) })
}
