import { getToken } from './auth'

// Netlify Functions（/api/*）への認証付きリクエスト用ヘルパー。
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
