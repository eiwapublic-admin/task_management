import { createClient } from '@supabase/supabase-js'

// Supabase プロジェクトの URL は公開値。シークレットの SUPABASE_URL が
// 未設定・URL 形式でない場合はこの値にフォールバックする（設定ミス対策）。
const DEFAULT_SUPABASE_URL = 'https://pfiogfdnbctunkhslmcp.supabase.co'

export function resolveSupabaseUrl() {
  const raw = process.env.SUPABASE_URL
  try {
    const url = new URL(raw)
    if (url.protocol === 'https:' || url.protocol === 'http:') return raw
  } catch {
    // fall through
  }
  return DEFAULT_SUPABASE_URL
}

// service role キーを使う管理用クライアント。
// このクライアントは Worker（サーバー側）でのみ生成し、
// フロントエンドには絶対に渡さない。RLS をバイパスして書き込みができる。
export function getAdminClient() {
  const { SUPABASE_SERVICE_KEY } = process.env
  if (!SUPABASE_SERVICE_KEY) {
    throw new Error('SUPABASE_SERVICE_KEY が設定されていません')
  }
  return createClient(resolveSupabaseUrl(), SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
