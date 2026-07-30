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

// スパム判定の付与・解除（/api/tasks の PATCH）。
// 付与時はサーバー側で「完了」にしてアーカイブへ即移動する（カンバンから外すのが目的）。
// 解除はフラグだけ戻す（アーカイブから戻すかどうかはステータス変更で選べる）。
export async function setTaskSpam(id, isSpam) {
  const data = await authFetch('/api/tasks', {
    method: 'PATCH',
    body: JSON.stringify({ id, is_spam: isSpam }),
  })
  return data.task || null
}

// 操作ログを新しい順に取得する。
export async function fetchLogs() {
  const data = await authFetch('/api/logs')
  return data.logs || []
}

// アーカイブ済みタスクを取得する（アーカイブ日の新しい順）。
// filters: { assignee, channel, q } で担当者・情報源・フリーワードの絞り込みが可能。
export async function fetchArchive({ assignee = '', channel = '', q = '' } = {}) {
  const params = new URLSearchParams()
  if (assignee) params.set('assignee', assignee)
  if (channel) params.set('channel', channel)
  if (q) params.set('q', q)
  const query = params.toString()
  const data = await authFetch(`/api/archive${query ? `?${query}` : ''}`)
  return data.tasks || []
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
