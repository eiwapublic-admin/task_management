import { getAdminClient } from './lib/supabase-admin.js'
import { json, verifyRequestAuth } from './lib/http.js'

// 設定の保存エンドポイント（/api/settings, PUT）。ログイン必須。
// フロントからの読み取りは anon キーで settings テーブルを直接 SELECT する
// （RLS で参照は許可済み）。書き込みだけ service role 経由に限定する。
const ALLOWED_KEYS = new Set([
  'fetch_interval_minutes',
  'assignees',
  'business_keywords',
  'org_context',
  'shared_gmail',
])

export default async (req) => {
  if (req.method !== 'PUT' && req.method !== 'POST') {
    return json({ error: 'Method Not Allowed' }, 405)
  }
  if (!verifyRequestAuth(req)) {
    return json({ error: '認証が必要です' }, 401)
  }

  try {
    const payload = await req.json().catch(() => null)
    if (!payload || typeof payload !== 'object') {
      return json({ error: 'JSON ボディが必要です' }, 400)
    }

    // 許可キーのみを文字列化して upsert する
    const rows = []
    for (const [key, value] of Object.entries(payload)) {
      if (!ALLOWED_KEYS.has(key)) continue
      const stringValue = typeof value === 'string' ? value : JSON.stringify(value)
      rows.push({ key, value: stringValue })
    }
    if (rows.length === 0) {
      return json({ error: '保存できる設定項目がありません' }, 400)
    }

    const supabase = getAdminClient()
    const { error } = await supabase.from('settings').upsert(rows, { onConflict: 'key' })
    if (error) {
      return json({ error: `保存に失敗しました: ${error.message}` }, 500)
    }
    return json({ ok: true, saved: rows.map((r) => r.key) })
  } catch (err) {
    console.error('settings 失敗:', err)
    return json({ error: String(err.message || err) }, 500)
  }
}

export const config = {
  path: '/api/settings',
}
