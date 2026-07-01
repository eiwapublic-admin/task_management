import { createClient } from '@supabase/supabase-js'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 })
  }

  const { username, password } = await req.json().catch(() => ({}))

  if (!username || !password) {
    return new Response(JSON.stringify({ error: 'username と password は必須です' }), {
      status: 400,
    })
  }

  const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  )

  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('id, username, password_hash, display_name')
    .eq('username', username)
    .maybeSingle()

  if (error || !user) {
    return new Response(JSON.stringify({ error: 'ユーザー名またはパスワードが違います' }), {
      status: 401,
    })
  }

  const valid = await bcrypt.compare(password, user.password_hash)
  if (!valid) {
    return new Response(JSON.stringify({ error: 'ユーザー名またはパスワードが違います' }), {
      status: 401,
    })
  }

  const token = jwt.sign(
    { sub: user.id, username: user.username, display_name: user.display_name },
    process.env.SESSION_SECRET,
    { expiresIn: '7d' }
  )

  return new Response(
    JSON.stringify({
      token,
      user: { id: user.id, username: user.username, display_name: user.display_name },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

export const config = {
  path: '/api/login',
}
