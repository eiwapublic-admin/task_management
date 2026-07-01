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
