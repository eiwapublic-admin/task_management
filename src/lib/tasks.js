import { authFetch } from './api'

// データ面（タスク・設定・ログ・利用量）は Worker の /api/* を JWT 認証つきで叩く。
// 以前は anon キーで Supabase を直接読み取っていたが、anon キーは公開値のため
// 匿名アクセスを全廃し、service role 経由の Worker API に統一した。

export async function fetchTasks() {
  const data = await authFetch('/api/tasks')
  return data.tasks || []
}

// ステータス変更の操作ログはサーバー側（Worker）が記録するため、
// フロントからの明示的な logStatusChange 呼び出しは不要になった。
export async function updateTaskStatus(id, status) {
  await authFetch('/api/tasks', { method: 'PATCH', body: JSON.stringify({ id, status }) })
}

// 操作ログを新しい順に取得する。
export async function fetchLogs() {
  const data = await authFetch('/api/logs')
  return data.logs || []
}

// settings を { key: value } に整形して返す。
export async function fetchSettings() {
  const data = await authFetch('/api/settings')
  return data.settings || {}
}

// 指定月（'YYYY-MM'）のAPI利用量を返す。無ければ null。
export async function fetchUsage(month) {
  const data = await authFetch(`/api/usage?month=${encodeURIComponent(month)}`)
  return data.usage || null
}
