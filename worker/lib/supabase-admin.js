import { createClient } from '@supabase/supabase-js'

// service role キーを使う管理用クライアント。
// このクライアントは Netlify Functions（サーバー側）でのみ生成し、
// フロントエンドには絶対に渡さない。RLS をバイパスして書き込みができる。
export function getAdminClient() {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY が設定されていません')
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
