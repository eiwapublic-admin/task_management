import jwt from 'jsonwebtoken'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

// Authorization: Bearer <token> を検証する。
// ログイン時に login.js が SESSION_SECRET で署名した JWT を想定。
// 検証に失敗した場合は null を返す（呼び出し側で 401 を返す）。
export function verifyRequestAuth(req) {
  const { SESSION_SECRET } = process.env
  if (!SESSION_SECRET) return null
  const header = req.headers.get('authorization') || ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match) return null
  try {
    return jwt.verify(match[1], SESSION_SECRET)
  } catch {
    return null
  }
}
