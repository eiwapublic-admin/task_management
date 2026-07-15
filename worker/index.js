import bcrypt from 'bcryptjs'
import { runPipeline } from './lib/pipeline.js'
import { json, verifyRequestAuth } from './lib/http.js'
import { signJwt } from './lib/jwt.js'
import { getAdminClient } from './lib/supabase-admin.js'
import { getAccessToken, getMessageAttachments, getThreadAttachments, getThreadMessages, getAttachmentData } from './lib/gmail.js'
import { makeIsCompanyAddress, parseCompanyDomains, resolveCounterpart } from './lib/mail-utils.js'

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

// タスクの手動登録・編集で使う定数
const VALID_STATUSES = new Set(['未処理', '返信済み', '対応中', '完了'])
const UNASSIGNED = '（担当未設定）'
const DUE_RE = /^\d{4}-\d{2}-\d{2}$/

// due_date の入力を正規化する（空文字/未指定は null、YYYY-MM-DD のみ許可）
function normalizeDueDate(value) {
  if (value === undefined) return undefined // 未指定（更新時は変更しない）
  if (value === null || value === '') return null
  if (typeof value === 'string' && DUE_RE.test(value.trim())) return value.trim()
  return undefined // 不正な形式は無視
}

// POST /api/tasks — タスクの手動登録。ログイン必須。
async function handleTaskCreate(req) {
  const auth = await verifyRequestAuth(req)
  if (!auth) return json({ error: '認証が必要です' }, 401)
  try {
    const payload = await req.json().catch(() => null)
    if (!payload || typeof payload !== 'object') {
      return json({ error: 'JSON ボディが必要です' }, 400)
    }
    const title = typeof payload.title === 'string' ? payload.title.trim() : ''
    if (!title) return json({ error: 'タイトルは必須です' }, 400)

    const status = VALID_STATUSES.has(payload.status) ? payload.status : '未処理'
    const assignee =
      typeof payload.assignee === 'string' && payload.assignee.trim()
        ? payload.assignee.trim()
        : UNASSIGNED
    const dueDate = normalizeDueDate(payload.due_date) ?? null
    const remarks =
      typeof payload.remarks === 'string' && payload.remarks.trim() ? payload.remarks.trim() : null

    // 手動登録は Gmail スレッドを持たないため、一意な合成 ID を割り当てる
    const syntheticId = `manual:${crypto.randomUUID()}`
    const now = new Date().toISOString()

    const supabase = getAdminClient()
    const { data, error } = await supabase
      .from('tasks')
      .insert({
        gmail_thread_id: syntheticId,
        gmail_message_id: syntheticId,
        source: 'manual',
        title: title.slice(0, 120),
        assignee,
        status,
        due_date: dueDate,
        sender: '手動登録',
        subject: title.slice(0, 120),
        remarks,
        received_at: now,
        classification_note: `${auth.display_name || auth.username || '不明なユーザー'} が手動で登録しました。`,
      })
      .select()
      .single()
    if (error) return json({ error: `登録に失敗しました: ${error.message}` }, 500)

    // 操作ログ
    await supabase.from('activity_logs').insert({
      log_type: 'status_change',
      actor: auth.display_name || auth.username || '不明なユーザー',
      message: `タスク「${title.slice(0, 120)}」を手動で登録`,
      detail: { task_id: data.id },
    })
    return json({ ok: true, task: data })
  } catch (err) {
    console.error('task-create 失敗:', err)
    return json({ error: String(err.message || err) }, 500)
  }
}

// PATCH /api/tasks — タスクの担当者・期限・留意事項・タイトルの編集。ログイン必須。
// フロントの anon キーは status 列しか更新できないため、その他の列は service role 経由で更新する。
async function handleTaskUpdate(req) {
  const auth = await verifyRequestAuth(req)
  if (!auth) return json({ error: '認証が必要です' }, 401)
  try {
    const payload = await req.json().catch(() => null)
    if (!payload || typeof payload !== 'object') {
      return json({ error: 'JSON ボディが必要です' }, 400)
    }
    const id = typeof payload.id === 'string' ? payload.id : ''
    if (!id) return json({ error: 'id は必須です' }, 400)

    const fields = {}
    if (typeof payload.assignee === 'string' && payload.assignee.trim()) {
      fields.assignee = payload.assignee.trim()
    }
    if (typeof payload.title === 'string' && payload.title.trim()) {
      fields.title = payload.title.trim().slice(0, 120)
    }
    if ('remarks' in payload) {
      fields.remarks =
        typeof payload.remarks === 'string' && payload.remarks.trim() ? payload.remarks.trim() : null
    }
    if ('due_date' in payload) {
      const d = normalizeDueDate(payload.due_date)
      if (d !== undefined) fields.due_date = d
    }
    if (Object.keys(fields).length === 0) {
      return json({ error: '更新できる項目がありません' }, 400)
    }

    const supabase = getAdminClient()
    const { data, error } = await supabase
      .from('tasks')
      .update(fields)
      .eq('id', id)
      .select()
      .single()
    if (error) return json({ error: `更新に失敗しました: ${error.message}` }, 500)
    return json({ ok: true, task: data })
  } catch (err) {
    console.error('task-update 失敗:', err)
    return json({ error: String(err.message || err) }, 500)
  }
}

// Gmail のメッセージIDは英数・ハイフン・アンダースコアのみ
const GMAIL_ID_RE = /^[A-Za-z0-9_-]+$/

// GET /api/attachments?thread_id=... （または ?message_id=...）
//   添付ファイル一覧（メタ情報）を返す。ログイン必須。
//   thread_id 指定時はスレッド内の全メッセージの添付を集約して返す（各添付に message_id 付き）。
//   これにより返信で本文が上書きされても、最初・途中の返信の添付が失われずに表示できる。
//   共有アカウントの認証情報で Gmail から取得するため、担当者が Gmail にログインしていなくても参照できる。
async function handleListAttachments(req) {
  if (!(await verifyRequestAuth(req))) return json({ error: '認証が必要です' }, 401)
  try {
    const params = new URL(req.url).searchParams
    const threadId = params.get('thread_id') || ''
    const messageId = params.get('message_id') || ''
    const accessToken = await getAccessToken()
    if (threadId) {
      if (!GMAIL_ID_RE.test(threadId)) return json({ error: 'thread_id が不正です' }, 400)
      // 対象タスクの顧客(counterpart)を特定し、同一件名で複数顧客が1スレッドに
      // まとまった場合に、別顧客宛メッセージの添付が混ざらないよう絞り込む。
      let counterpart = ''
      try {
        const supabase = getAdminClient()
        const { data: task } = await supabase
          .from('tasks')
          .select('sender, sender_email, gmail_message_id')
          .eq('gmail_thread_id', threadId)
          .maybeSingle()
        if (task) {
          const { data: settingsRows } = await supabase
            .from('settings')
            .select('key, value')
            .in('key', ['company_domains', 'shared_gmail'])
          const settings = {}
          for (const r of settingsRows || []) settings[r.key] = r.value
          const isCompanyAddress = makeIsCompanyAddress(
            settings.shared_gmail,
            parseCompanyDomains(settings.company_domains)
          )
          const meta = await getThreadMessages(accessToken, threadId)
          counterpart = resolveCounterpart(task, meta, isCompanyAddress)
        }
      } catch (e) {
        // 顧客特定に失敗しても添付一覧自体は返す（フィルタ無し）
        console.error('counterpart 特定失敗:', e)
      }
      const all = await getThreadAttachments(accessToken, threadId, counterpart)
      // 同一ファイル（ファイル名 + サイズ + MIME）が複数メッセージに現れる場合は1件に集約する
      const seen = new Map()
      for (const a of all) {
        const key = `${a.filename}|${a.size}|${a.mimeType}`
        if (!seen.has(key)) seen.set(key, a)
      }
      return json({ attachments: Array.from(seen.values()) })
    }
    if (!GMAIL_ID_RE.test(messageId)) return json({ error: 'message_id が不正です' }, 400)
    const attachments = await getMessageAttachments(accessToken, messageId)
    return json({ attachments })
  } catch (err) {
    console.error('attachments 一覧取得失敗:', err)
    return json({ error: String(err.message || err) }, 500)
  }
}

// base64url 文字列をバイト列に変換する
function base64UrlToBytes(data) {
  const normalized = (data || '').replace(/-/g, '+').replace(/_/g, '/')
  return new Uint8Array(Buffer.from(normalized, 'base64'))
}

// GET /api/attachment?message_id=..&attachment_id=..&filename=..&mime=.. — 添付ファイル本体を返す。ログイン必須。
async function handleDownloadAttachment(req) {
  if (!(await verifyRequestAuth(req))) return json({ error: '認証が必要です' }, 401)
  try {
    const params = new URL(req.url).searchParams
    const messageId = params.get('message_id') || ''
    const attachmentId = params.get('attachment_id') || ''
    const filename = (params.get('filename') || 'attachment').slice(0, 255)
    const mimeType = params.get('mime') || 'application/octet-stream'
    if (!GMAIL_ID_RE.test(messageId)) return json({ error: 'message_id が不正です' }, 400)
    if (!attachmentId) return json({ error: 'attachment_id が必要です' }, 400)

    const accessToken = await getAccessToken()
    const { data } = await getAttachmentData(accessToken, messageId, attachmentId)
    const bytes = base64UrlToBytes(data)

    // Content-Disposition のファイル名: ASCII フォールバック + RFC 5987 の UTF-8 指定を併記
    const asciiName = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')
    const encodedName = encodeURIComponent(filename)
    return new Response(bytes, {
      headers: {
        'Content-Type': mimeType,
        'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    console.error('attachment ダウンロード失敗:', err)
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
    if (pathname === '/api/tasks') {
      if (req.method === 'POST') return handleTaskCreate(req)
      if (req.method === 'PATCH' || req.method === 'PUT') return handleTaskUpdate(req)
      return json({ error: 'Method Not Allowed' }, 405)
    }
    if (pathname === '/api/attachments') {
      return req.method === 'GET' ? handleListAttachments(req) : json({ error: 'Method Not Allowed' }, 405)
    }
    if (pathname === '/api/attachment') {
      return req.method === 'GET' ? handleDownloadAttachment(req) : json({ error: 'Method Not Allowed' }, 405)
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
