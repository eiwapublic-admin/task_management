import { supabase } from './supabase'

// tasks / settings は anon キーで直接読み取る（RLS で参照許可済み）。
// 書き込みは status 列の更新のみ anon に許可されている。

export async function fetchTasks() {
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .order('received_at', { ascending: false })
  if (error) throw new Error(`タスクの取得に失敗しました: ${error.message}`)
  return data || []
}

export async function updateTaskStatus(id, status) {
  const { error } = await supabase.from('tasks').update({ status }).eq('id', id)
  if (error) throw new Error(`ステータスの更新に失敗しました: ${error.message}`)
}

// ステータス変更の操作ログを残す（失敗しても本処理は妨げない前提で呼び出し側が catch する）
export async function logStatusChange(task, fromStatus, toStatus, actor) {
  const { error } = await supabase.from('activity_logs').insert({
    log_type: 'status_change',
    actor: actor || '不明なユーザー',
    message: `「${task.title}」のステータスを ${fromStatus} → ${toStatus} に変更`,
    detail: { task_id: task.id },
  })
  if (error) throw new Error(`ログの記録に失敗しました: ${error.message}`)
}

// 操作ログを新しい順に取得する。
export async function fetchLogs(limit = 200) {
  const { data, error } = await supabase
    .from('activity_logs')
    .select('id, log_type, actor, message, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`ログの取得に失敗しました: ${error.message}`)
  return data || []
}

// settings テーブルを { key: value } に整形して返す。
export async function fetchSettings() {
  const { data, error } = await supabase.from('settings').select('key, value')
  if (error) throw new Error(`設定の取得に失敗しました: ${error.message}`)
  const map = {}
  for (const row of data || []) map[row.key] = row.value
  return map
}

// 指定月（'YYYY-MM'）のAPI利用量を返す。無ければ null。
export async function fetchUsage(month) {
  const { data, error } = await supabase
    .from('api_usage')
    .select('month, input_tokens, output_tokens, calls, updated_at')
    .eq('month', month)
    .maybeSingle()
  if (error) throw new Error(`利用量の取得に失敗しました: ${error.message}`)
  return data
}
