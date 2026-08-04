import { verifyJwt } from './jwt.js'
import { getAdminClient } from './supabase-admin.js'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

// 全レスポンス共通のセキュリティヘッダ。クリックジャッキング（X-Frame-Options）・
// MIMEスニッフィング（X-Content-Type-Options）対策、リファラーの最小化、
// 自己ホストのアセットのみを許可するCSPを付与する。
// アプリは外部CDN・フォント・画像を一切使わず同一オリジンで完結しているため、
// ほぼ全ディレクティブを 'self' に絞れる。
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  // blob: は添付ファイル（画像・PDF）のアプリ内プレビュー用（2026-07-22）。
  // ダウンロードしたBlobをURL.createObjectURL()で表示するため、img-src・
  // frame-srcの両方に必要（無いと<img>/<iframe>のblob: URLが読み込めず、
  // 画像が壊れて見える・PDFが真っ白になる）。
  "img-src 'self' data: blob:",
  "frame-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ')

// 静的アセット/API どちらのレスポンスにも同じヘッダを付与する。
// Response.headers は fetch() が返した直後であれば変更可能なため、
// 新しい Headers にコピーしてから追記する（元レスポンスの body/status は維持）。
export function withSecurityHeaders(response) {
  const headers = new Headers(response.headers)
  // 既定はフレーム埋め込み全面禁止（クリックジャッキング対策）。ただしレスポンス側で
  // 明示的に X-Frame-Options / CSP を設定済みの場合は尊重する（添付ファイルの
  // アプリ内PDFプレビューだけは同一オリジンのiframe埋め込みを許可するため、
  // handleDownloadAttachment が SAMEORIGIN / frame-ancestors 'self' を先に設定する）。
  if (!headers.has('X-Frame-Options')) {
    headers.set('X-Frame-Options', 'DENY')
  }
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  if (!headers.has('Content-Security-Policy')) {
    headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
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
      .select('token_version, role')
      .eq('id', payload.sub)
      .maybeSingle()
    // ユーザーが存在しない、または token_version が不一致（＝失効済み）なら無効
    if (error || !user) return null
    const currentVersion = user.token_version ?? 0
    const tokenVersion = payload.tv ?? 0
    if (currentVersion !== tokenVersion) return null
    // ロールは常にDBの現在値を正とする（JWTに埋めた値ではなく毎回引く）。
    // 権限を下げた時に有効期限（30日）を待たずに即反映させるため。
    // role 列が無い場合や未設定は staff 扱い（後方互換）。
    payload.role = user.role || 'staff'
  } catch (err) {
    console.error('verifyRequestAuth: token_version 突合に失敗', err)
    return null // フェイルクローズ（DB参照できない場合は無効扱い）
  }

  return payload
}

// ロール判定（2026-08-04。日報機能の追加に伴う権限分離）
//  staff  : 従来どおり全機能
//  owner  : 日報の閲覧のみ。書き込みとタスク管理系APIは不可（小泉産業様向け）
//  admin  : staff と同等（将来の分離用）
// role が未設定・不明な値のときは staff 扱いにはせず、最も制限の強い扱いにはしない。
// 既存ユーザーは全員 role='staff' が入るため、この分岐で挙動が変わることはない。
export function isOwner(auth) {
  return (auth?.role || 'staff') === 'owner'
}

// 書き込みを許可してよいか（owner は読み取り専用）
export function canWrite(auth) {
  return Boolean(auth) && !isOwner(auth)
}

// タスク管理セクションを使ってよいか（owner は日報のみ）
export function canUseTaskSection(auth) {
  return Boolean(auth) && !isOwner(auth)
}
