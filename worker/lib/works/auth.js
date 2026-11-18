// 勤怠管理（eWorks）の認証・権限（docs/eworks-plan.md 11章）
//
// ログイン ID・パスワードと JWT は既存のタスク管理と共通（users テーブル・SESSION_SECRET）。
// アプリごとに 1 回ログインする（トークンは eWorks の画面側で別に保存する）。
//
// 権限の考え方（判定は必ずここ＝Worker 側で行う）:
//   works_admin=true の利用者 … 全員の勤務・マスタ・利用者（招待）を扱える
//   それ以外（現場スタッフ・一般の利用者）… 自分（works_staff.user_id が自分）の勤務だけ
import bcrypt from 'bcryptjs'
import { json, verifyRequestAuth } from '../http.js'
import { signJwt } from '../jwt.js'
import { getAdminClient } from '../supabase-admin.js'

const LOGIN_MAX_ATTEMPTS = 8
const LOGIN_LOCKOUT_SECONDS = 15 * 60

// リクエストの利用者を返す。{ auth, user, staff } / 未認証なら null
//   user  … users の行（id, username, display_name, role, works_admin）
//   staff … 自分に紐づく works_staff（無ければ null）
export async function getWorksContext(req) {
  const auth = await verifyRequestAuth(req, { allowFieldStaff: true })
  if (!auth) return null
  const supabase = getAdminClient()
  const { data: user, error } = await supabase
    .from('users')
    .select('id, username, display_name, role, works_admin')
    .eq('id', auth.sub)
    .maybeSingle()
  if (error || !user) return null
  const { data: staff } = await supabase
    .from('works_staff')
    .select('id, code, name, status')
    .eq('user_id', user.id)
    .maybeSingle()
  return { auth, user, staff: staff || null, isAdmin: !!user.works_admin }
}

// 認証必須。admin=true なら eWorks 管理者だけ。満たさなければ Response を返す
export async function requireWorks(req, { admin = false } = {}) {
  const ctx = await getWorksContext(req)
  if (!ctx) return { error: json({ error: '認証が必要です' }, 401) }
  if (admin && !ctx.isAdmin) return { error: json({ error: 'この操作は eWorks 管理者だけができます' }, 403) }
  return { ctx }
}

function publicUser(user, staff) {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role || 'staff',
    works_admin: !!user.works_admin,
    staff: staff ? { id: staff.id, code: staff.code, name: staff.name } : null,
  }
}

export async function issueToken(user) {
  return signJwt(
    { sub: user.id, username: user.username, display_name: user.display_name, tv: user.token_version ?? 0 },
    process.env.SESSION_SECRET
  )
}

// POST /api/works/login — 既存のログインと同じ手順（試行回数の制限つき）。
// eWorks には、現場スタッフ・eWorks 管理者・自分のスタッフ情報が紐づいている利用者だけが入れる
export async function handleWorksLogin(req, env) {
  try {
    const { username, password } = await req.json().catch(() => ({}))
    if (!username || !password) return json({ error: 'ログインIDとパスワードを入力してください' }, 400)
    if (!process.env.SUPABASE_SERVICE_KEY || !process.env.SESSION_SECRET) {
      console.error('works-login: 必要な環境変数が設定されていません')
      return json({ error: 'サーバー設定エラーが発生しました' }, 500)
    }
    const kv = env?.LOGIN_ATTEMPTS || null
    const ip = req.headers.get('cf-connecting-ip') || 'unknown'
    const key = `fail:${ip}:${username}`
    if (kv && (Number(await kv.get(key)) || 0) >= LOGIN_MAX_ATTEMPTS) {
      return json({ error: '試行回数が多すぎます。しばらくしてから再度お試しください' }, 429)
    }
    const supabase = getAdminClient()
    const { data: user } = await supabase
      .from('users')
      .select('id, username, password_hash, display_name, token_version, role, works_admin')
      .eq('username', username)
      .maybeSingle()
    const ok = user && (await bcrypt.compare(password, user.password_hash))
    if (!ok) {
      if (kv) await kv.put(key, String((Number(await kv.get(key)) || 0) + 1), { expirationTtl: LOGIN_LOCKOUT_SECONDS })
      return json({ error: 'ログインIDまたはパスワードが違います' }, 401)
    }
    if (kv) await kv.delete(key)
    const { data: staff } = await supabase.from('works_staff').select('id, code, name, status').eq('user_id', user.id).maybeSingle()
    if (!user.works_admin && !staff) {
      return json({ error: 'このIDは eWorks の利用者として登録されていません。管理者にお問い合わせください' }, 403)
    }
    if (staff && staff.status === 'retired' && !user.works_admin) {
      return json({ error: 'このIDは利用停止になっています' }, 403)
    }
    return json({ token: await issueToken(user), user: publicUser(user, staff) })
  } catch (err) {
    console.error('works-login: 予期しないエラー', err)
    return json({ error: 'ログイン処理でエラーが発生しました' }, 500)
  }
}

// GET /api/works/me — 画面の出し分け用（権限の正はサーバー側）
export async function handleWorksMe(req) {
  const ctx = await getWorksContext(req)
  if (!ctx) return json({ error: '認証が必要です' }, 401)
  return json({ user: publicUser(ctx.user, ctx.staff) })
}
