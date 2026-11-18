// 勤怠管理（eWorks）の招待（初回登録・パスワード再設定。docs/eworks-plan.md 11-2）
//
//   管理者: POST /api/works/invites { staff_id, kind } → 招待リンク（1 回だけ表示）
//   本人  : POST /api/works/invite/check  { token }                     → 氏名・種類
//           POST /api/works/invite/accept { token, username, password } → 登録してログイン
//
// 招待の合言葉は推測できない乱数（32 バイト）。DB には SHA-256 のハッシュだけを保存し、1 回使うと無効。
import bcrypt from 'bcryptjs'
import { json } from '../http.js'
import { getAdminClient } from '../supabase-admin.js'
import { issueToken, requireWorks } from './auth.js'
import { log } from './masters.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/
const ACCEPT_MAX_ATTEMPTS = 10
const ACCEPT_LOCKOUT_SECONDS = 15 * 60

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// GET    /api/works/invites?staff_id=… — スタッフの招待の一覧（新しい順）
// POST   /api/works/invites             — 発行
// DELETE /api/works/invites?id=…        — 未使用の招待を取り消す
export async function handleInvites(req) {
  const { ctx, error } = await requireWorks(req, { admin: true })
  if (error) return error
  const supabase = getAdminClient()
  const url = new URL(req.url)

  if (req.method === 'GET') {
    const staffId = url.searchParams.get('staff_id')
    if (!UUID_RE.test(String(staffId || ''))) return json({ error: 'staff_id が正しくありません' }, 400)
    const { data, error: e } = await supabase
      .from('works_invites')
      .select('id, kind, expires_at, used_at, revoked_at, created_at')
      .eq('staff_id', staffId)
      .order('created_at', { ascending: false })
      .limit(20)
    if (e) throw e
    return json({ items: data })
  }

  if (req.method === 'POST') {
    const b = await req.json().catch(() => ({}))
    if (!UUID_RE.test(String(b.staff_id || ''))) return json({ error: 'スタッフが正しくありません' }, 400)
    const kind = b.kind === 'reset' ? 'reset' : 'register'
    const { data: staff } = await supabase.from('works_staff').select('id, code, name, status, user_id').eq('id', b.staff_id).maybeSingle()
    if (!staff) return json({ error: 'スタッフが見つかりません' }, 404)
    if (staff.status === 'retired') return json({ error: '退職のスタッフには発行できません' }, 400)
    if (kind === 'register' && staff.user_id) return json({ error: 'このスタッフはすでに登録済みです。パスワードを忘れた場合は「再設定」を発行してください' }, 400)
    if (kind === 'reset' && !staff.user_id) return json({ error: 'まだ登録されていません。「招待」を発行してください' }, 400)
    const { data: settings } = await supabase.from('works_settings').select('invite_valid_days').eq('id', 1).maybeSingle()
    const days = settings?.invite_valid_days || 7
    // 同じスタッフの未使用の招待は取り消す（有効な招待を常に 1 つにする）
    await supabase.from('works_invites').update({ revoked_at: new Date().toISOString() }).eq('staff_id', staff.id).is('used_at', null).is('revoked_at', null)
    const token = randomToken()
    const expiresAt = new Date(Date.now() + days * 86400 * 1000).toISOString()
    const { error: e } = await supabase.from('works_invites').insert({
      staff_id: staff.id,
      kind,
      token_hash: await sha256(token),
      expires_at: expiresAt,
      created_by: ctx.user.id,
    })
    if (e) throw e
    await log(supabase, ctx, `${kind === 'reset' ? 'パスワード再設定' : '招待'}を発行: ${staff.code} ${staff.name}`)
    // リンクの合言葉は # の後ろに置く（サーバーのアクセスログ・リファラーに残さないため）
    return json({ url: `${url.origin}/invite#${token}`, expires_at: expiresAt, kind })
  }

  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id')
    if (!UUID_RE.test(String(id || ''))) return json({ error: 'id が正しくありません' }, 400)
    const { error: e } = await supabase.from('works_invites').update({ revoked_at: new Date().toISOString() }).eq('id', id).is('used_at', null)
    if (e) throw e
    await log(supabase, ctx, '招待を取り消し')
    return json({ ok: true })
  }
  return json({ error: 'Method Not Allowed' }, 405)
}

async function findValidInvite(supabase, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null
  const { data: inv } = await supabase
    .from('works_invites')
    .select('id, staff_id, kind, expires_at, used_at, revoked_at')
    .eq('token_hash', await sha256(token))
    .maybeSingle()
  if (!inv || inv.used_at || inv.revoked_at || new Date(inv.expires_at) < new Date()) return null
  const { data: staff } = await supabase.from('works_staff').select('id, code, name, status, user_id').eq('id', inv.staff_id).maybeSingle()
  if (!staff || staff.status === 'retired') return null
  return { inv, staff }
}

async function limited(req, env) {
  const kv = env?.LOGIN_ATTEMPTS || null
  const key = `invite:${req.headers.get('cf-connecting-ip') || 'unknown'}`
  if (!kv) return { blocked: false, fail: async () => {}, clear: async () => {} }
  const n = Number(await kv.get(key)) || 0
  return {
    blocked: n >= ACCEPT_MAX_ATTEMPTS,
    fail: () => kv.put(key, String(n + 1), { expirationTtl: ACCEPT_LOCKOUT_SECONDS }),
    clear: () => kv.delete(key),
  }
}

// POST /api/works/invite/check — 招待が有効か（ログイン不要）
export async function handleInviteCheck(req, env) {
  const rl = await limited(req, env)
  if (rl.blocked) return json({ error: '試行回数が多すぎます。しばらくしてから再度お試しください' }, 429)
  const { token } = await req.json().catch(() => ({}))
  const found = await findValidInvite(getAdminClient(), token)
  if (!found) {
    await rl.fail()
    return json({ error: 'この招待は使えません（期限切れ・使用済み・取り消し済み）。管理者に再発行を依頼してください' }, 404)
  }
  let username = null
  if (found.inv.kind === 'reset' && found.staff.user_id) {
    const { data: u } = await getAdminClient().from('users').select('username').eq('id', found.staff.user_id).maybeSingle()
    username = u?.username || null
  }
  return json({ kind: found.inv.kind, staff: { code: found.staff.code, name: found.staff.name }, username })
}

// POST /api/works/invite/accept — 登録（またはパスワード再設定）してログインする
export async function handleInviteAccept(req, env) {
  const rl = await limited(req, env)
  if (rl.blocked) return json({ error: '試行回数が多すぎます。しばらくしてから再度お試しください' }, 429)
  const { token, username, password } = await req.json().catch(() => ({}))
  const supabase = getAdminClient()
  const found = await findValidInvite(supabase, token)
  if (!found) {
    await rl.fail()
    return json({ error: 'この招待は使えません（期限切れ・使用済み・取り消し済み）。管理者に再発行を依頼してください' }, 404)
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
    return json({ error: 'パスワードは 8 文字以上で決めてください' }, 400)
  }
  const { inv, staff } = found
  if (inv.kind === 'register' && !USERNAME_RE.test(String(username || ''))) {
    return json({ error: 'ログインIDは半角の英数字と . _ - で 3〜32 文字にしてください' }, 400)
  }
  // 同じリンクで同時に 2 回登録されないよう、先に「使用済み」にしてから処理する（失敗したら戻す）
  const { data: claimed } = await supabase
    .from('works_invites')
    .update({ used_at: new Date().toISOString() })
    .eq('id', inv.id)
    .is('used_at', null)
    .is('revoked_at', null)
    .select('id')
  if (!claimed?.length) return json({ error: 'この招待は使えません（期限切れ・使用済み・取り消し済み）。管理者に再発行を依頼してください' }, 404)
  const release = () => supabase.from('works_invites').update({ used_at: null }).eq('id', inv.id)
  try {
    const res = await acceptInvite(supabase, inv, staff, username, password)
    if (res instanceof Response) {
      await release()
      return res
    }
    await rl.clear()
    await log(supabase, { user: res }, `${inv.kind === 'reset' ? 'パスワードを再設定' : '利用登録'}: ${staff.code} ${staff.name}`)
    return json({
      token: await issueToken(res),
      user: {
        id: res.id,
        username: res.username,
        display_name: res.display_name,
        role: res.role,
        works_admin: !!res.works_admin,
        staff: { id: staff.id, code: staff.code, name: staff.name },
      },
    })
  } catch (err) {
    await release()
    throw err
  }
}

// 登録または再設定の本体。成功なら users の行、利用者に返すエラーなら Response を返す
async function acceptInvite(supabase, inv, staff, username, password) {
  const hash = await bcrypt.hash(password, 10)
  let user
  if (inv.kind === 'register') {
    if (staff.user_id) return json({ error: 'このスタッフはすでに登録済みです' }, 400)
    const { data: created, error: e } = await supabase
      .from('users')
      .insert({ username, password_hash: hash, display_name: staff.name, role: 'field_staff' })
      .select('id, username, display_name, token_version, role, works_admin')
      .single()
    if (e) {
      if (e.code === '23505') return json({ error: 'このログインIDはすでに使われています。別のIDにしてください' }, 409)
      throw e
    }
    const { data: linked, error: e2 } = await supabase
      .from('works_staff')
      .update({ user_id: created.id, updated_at: new Date().toISOString() })
      .eq('id', staff.id)
      .is('user_id', null)
      .select('id')
    if (e2 || !linked?.length) {
      // 紐づけできなかった利用者は残さない
      await supabase.from('users').delete().eq('id', created.id)
      if (e2) throw e2
      return json({ error: 'このスタッフはすでに登録済みです' }, 400)
    }
    user = created
  } else {
    // パスワード再設定: 既存のトークンはすべて失効させる（token_version を進める）
    const { data: cur } = await supabase.from('users').select('id, token_version, role').eq('id', staff.user_id).maybeSingle()
    if (!cur) return json({ error: '利用者が見つかりません' }, 404)
    // 事務所の利用者（タスク管理と共通の ID）のパスワードはここでは変えない
    if (cur.role !== 'field_staff') return json({ error: 'この ID のパスワードはタスク管理の管理者に再設定を依頼してください' }, 400)
    const { data: updated, error: e } = await supabase
      .from('users')
      .update({ password_hash: hash, token_version: (cur.token_version ?? 0) + 1 })
      .eq('id', cur.id)
      .select('id, username, display_name, token_version, role, works_admin')
      .single()
    if (e) throw e
    user = updated
  }
  return user
}
