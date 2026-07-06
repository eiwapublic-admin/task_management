import bcrypt from 'bcryptjs'
import { runPipeline } from './lib/pipeline.js'
import { json, verifyRequestAuth } from './lib/http.js'
import { signJwt } from './lib/jwt.js'
import { getAdminClient } from './lib/supabase-admin.js'

// Cloudflare Worker 本体。
// - fetch:    /api/* を処理し、それ以外は静的アセット（Vite ビルド成果物）へフォールバック
// - scheduled: 5分ごとの Cron Trigger でメール取得パイプラインを実行
//   （実際の取得間隔は settings.fetch_interval_minutes で runPipeline 内がゲート）

// POST /api/login — ユーザー名/パスワード認証して JWT を返す
async function handleLogin(req) {
  try {
    const { username, password } = await req.json().catch(() => ({}))
    if (!username || !password) {
      return json({ error: 'username と password は必須です' }, 400)
    }

    // 必須の環境変数が欠けている場合は明確に落とす（fail closed）
    const { SUPABASE_SERVICE_KEY, SESSION_SECRET } = process.env
    if (!SUPABASE_SERVICE_KEY || !SESSION_SECRET) {
      console.error('login: 必要な環境変数が設定されていません')
      return json({ error: 'サーバー設定エラーが発生しました' }, 500)
    }

    const supabaseAdmin = getAdminClient()

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

    const token = await signJwt(
      { sub: user.id, username: user.username, display_name: user.display_name },
      SESSION_SECRET
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

// POST /api/run-fetch — 手動即時実行（「今すぐ取得」ボタン）。ログイン必須。
async function handleRunFetch(req) {
  const auth = await verifyRequestAuth(req)
  if (!auth) {
    return json({ error: '認証が必要です' }, 401)
  }
  try {
    const summary = await runPipeline({ force: true, actor: auth.display_name || auth.username || '不明なユーザー' })
    return json(summary)
  } catch (err) {
    console.error('run-fetch 失敗:', err)
    return json({ error: String(err.message || err) }, 500)
  }
}

// PUT /api/settings — 設定の保存。ログイン必須。
// フロントからの読み取りは anon キーで settings テーブルを直接 SELECT する
// （RLS で参照は許可済み）。書き込みだけ service role 経由に限定する。
const ALLOWED_SETTING_KEYS = new Set([
  'fetch_interval_minutes',
  'active_hours_start',
  'active_hours_end',
  'assignees',
  'business_keywords',
  'org_context',
  'shared_gmail',
  'company_domains',
  'calendar_name',
])

async function handleSettings(req) {
  if (!(await verifyRequestAuth(req))) {
    return json({ error: '認証が必要です' }, 401)
  }
  try {
    const payload = await req.json().catch(() => null)
    if (!payload || typeof payload !== 'object') {
      return json({ error: 'JSON ボディが必要です' }, 400)
    }

    // 許可キーのみを文字列化して upsert する
    const rows = []
    for (const [key, value] of Object.entries(payload)) {
      if (!ALLOWED_SETTING_KEYS.has(key)) continue
      const stringValue = typeof value === 'string' ? value : JSON.stringify(value)
      rows.push({ key, value: stringValue })
    }
    if (rows.length === 0) {
      return json({ error: '保存できる設定項目がありません' }, 400)
    }

    const supabase = getAdminClient()
    const { error } = await supabase.from('settings').upsert(rows, { onConflict: 'key' })
    if (error) {
      return json({ error: `保存に失敗しました: ${error.message}` }, 500)
    }
    return json({ ok: true, saved: rows.map((r) => r.key) })
  } catch (err) {
    console.error('settings 失敗:', err)
    return json({ error: String(err.message || err) }, 500)
  }
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url)

    if (pathname === '/api/login') {
      return req.method === 'POST' ? handleLogin(req) : json({ error: 'Method Not Allowed' }, 405)
    }
    if (pathname === '/api/run-fetch') {
      return req.method === 'POST' ? handleRunFetch(req) : json({ error: 'Method Not Allowed' }, 405)
    }
    if (pathname === '/api/settings') {
      return req.method === 'PUT' || req.method === 'POST'
        ? handleSettings(req)
        : json({ error: 'Method Not Allowed' }, 405)
    }
    if (pathname.startsWith('/api/')) {
      return json({ error: 'Not Found' }, 404)
    }

    // 静的アセット（SPA フォールバックは wrangler.jsonc の not_found_handling で処理）
    return env.ASSETS.fetch(req)
  },

  async scheduled(_event, _env, ctx) {
    ctx.waitUntil(
      runPipeline({ force: false })
        .then((summary) => console.log('scheduled fetch 完了:', JSON.stringify(summary)))
        .catch((err) => console.error('scheduled fetch 失敗:', err))
    )
  },
}
