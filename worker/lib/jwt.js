// HS256 の JWT を Web Crypto API で署名・検証する軽量実装。
// Cloudflare Workers では Node 専用の jsonwebtoken が使えないため自前で持つ。

const encoder = new TextEncoder()

function base64UrlEncode(bytes) {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(str) {
  const normalized = str.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function importKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
}

// payload に iat / exp（秒）を付与して署名する。expiresInSeconds 既定は30日。
// 社内の放置運用ツールのため、頻繁な再ログインを避ける狙いで長めに取る。
export async function signJwt(payload, secret, expiresInSeconds = 30 * 24 * 60 * 60) {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'HS256', typ: 'JWT' }
  const body = { ...payload, iat: now, exp: now + expiresInSeconds }
  const headerPart = base64UrlEncode(encoder.encode(JSON.stringify(header)))
  const payloadPart = base64UrlEncode(encoder.encode(JSON.stringify(body)))
  const signingInput = `${headerPart}.${payloadPart}`
  const key = await importKey(secret)
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput))
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`
}

// 署名と有効期限を検証し、成功時はペイロードを、失敗時は null を返す。
export async function verifyJwt(token, secret) {
  const parts = (token || '').split('.')
  if (parts.length !== 3) return null
  const [headerPart, payloadPart, signaturePart] = parts
  try {
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerPart)))
    if (header.alg !== 'HS256') return null
    const key = await importKey(secret)
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlDecode(signaturePart),
      encoder.encode(`${headerPart}.${payloadPart}`)
    )
    if (!valid) return null
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadPart)))
    if (typeof payload.exp === 'number' && Date.now() / 1000 >= payload.exp) return null
    return payload
  } catch {
    return null
  }
}
