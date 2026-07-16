import { verifyJwt } from './jwt.js'
import { getAdminClient } from './supabase-admin.js'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

// Authorization: Bearer <token> を検証する。
// ログイン時に SESSION_SECRET で署名した JWT を想定。
// 検証に失敗した場合は null を返す（呼び出し側で 401 を返す）。
//
// 署名・有効期限に加えて、users.token_version との突合による失効チェックも行う。
// トークン発行時の tv（= その時点の token_version）と DB の現在値が一致しない
// トークンは無効とみなす。パスワード変更・退職・トークン漏洩時に
// token_version をインクリメントするだけで、その利用者の既存トークンを
// 期限（30日）を待たずに即時失効できる。
export async function verifyRequestAuth(req) {
  const { SESSION_SECRET } = process.env
  if (!SESSION_SECRET) return null
  const header = req.headers.get('authorization') || ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match) return null
  const payload = await verifyJwt(match[1], SESSION_SECRET)
  if (!payload || !payload.sub) return null

  try {
    const supabase = getAdminClient()
    const { data: user, error } = await supabase
      .from('users')
      .select('token_version')
      .eq('id', payload.sub)
      .maybeSingle()
    // ユーザーが存在しない、または token_version が不一致（＝失効済み）なら無効
    if (error || !user) return null
    const currentVersion = user.token_version ?? 0
    const tokenVersion = payload.tv ?? 0
    if (currentVersion !== tokenVersion) return null
  } catch (err) {
    console.error('verifyRequestAuth: token_version 突合に失敗', err)
    return null // フェイルクローズ（DB参照できない場合は無効扱い）
  }

  return payload
}
