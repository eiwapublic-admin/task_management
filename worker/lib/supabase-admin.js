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

// 新方式のAPIキー（sb_secret_.../sb_publishable_...）はJWTではないため、Authorization: Bearer
// に載せると拒否される（storage.js のauthHeaders()と同じ理由。Supabase公式ドキュメント）。
// @supabase/supabase-js は2.112.4時点でも鍵の形式を判別せず、.from()等の通常のリクエストでは
// 常にAuthorization: Bearerにも同じ値を載せてしまう（内部の fetchWithAuth が無条件に設定する）。
// global.fetch にはヘッダー付与済みのリクエストが渡ってくるため、ここで新方式キーの場合だけ
// Authorizationヘッダーを取り除いてSDK側の挙動を補正する（apikeyヘッダーは正しく付与されるため
// 触らない）。レガシーのJWT形式キーでは何もしない（従来どおり両方のヘッダーが送られる）。
function isNewApiKey(key) {
  return key.startsWith('sb_secret_') || key.startsWith('sb_publishable_')
}

function stripBearerForNewApiKey(input, init) {
  const headers = new Headers(init?.headers)
  headers.delete('Authorization')
  return fetch(input, { ...init, headers })
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
    ...(isNewApiKey(SUPABASE_SERVICE_KEY) ? { global: { fetch: stripBearerForNewApiKey } } : {}),
  })
}
