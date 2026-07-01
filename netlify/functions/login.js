import { createClient } from '@supabase/supabase-js'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

export default async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'Method Not Allowed' }, 405)
  }

  try {
    const { username, password } = await req.json().catch(() => ({}))

    if (!username || !password) {
      return json({ error: 'username と password は必須です' }, 400)
    }

    // 必須の環境変数が欠けている場合は明確に落とす（fail closed）
    const { SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SECRET } = process.env
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !SESSION_SECRET) {
      console.error('login: 必要な環境変数が設定されていません')
      return json({ error: 'サーバー設定エラーが発生しました' }, 500)
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('id, username, password_hash, display_name')
      .eq('username', username)
      .maybeSingle()

    // ユーザー不在とパスワード不一致は同じメッセージにして、ユーザー名の存在を推測させない
    if (error || !user) {
      return json({ error: 'ユーザー名またはパスワードが違います' }, 401)
    }

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      return json({ error: 'ユーザー名またはパスワードが違います' }, 401)
    }

    const token = jwt.sign(
      { sub: user.id, username: user.username, display_name: user.display_name },
      SESSION_SECRET,
      { expiresIn: '7d' }
    )

    return json({
      token,
      user: { id: user.id, username: user.username, display_name: user.display_name },
    })
  } catch (err) {
    console.error('login: 予期しないエラー', err)
    return json({ error: 'ログイン処理でエラーが発生しました' }, 500)
  }
}

export const config = {
  path: '/api/login',
}
