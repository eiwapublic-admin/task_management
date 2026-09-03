import bcrypt from 'bcryptjs'
import { runPipeline } from './lib/pipeline.js'
import { json, verifyRequestAuth, withSecurityHeaders } from './lib/http.js'
import { signJwt, verifyJwt } from './lib/jwt.js'
import { getAdminClient } from './lib/supabase-admin.js'
import { getAccessToken, getMessageAttachments, getThreadAttachments, getThreadMessages, getAttachmentData } from './lib/gmail.js'
import { makeIsCompanyAddress, parseCompanyDomains, resolveCounterpart } from './lib/mail-utils.js'
import {
  handleReportList,
  handleReportGet,
  handleReportCreate,
  handleReportUpdate,
  handleReportDelete,
  handleEntryCreate,
  handleEntryUpdate,
  handleEntryDelete,
  handleTemplateList,
  handleTemplateSave,
  handlePhotoList,
  handlePhotoUpload,
  handlePhotoGet,
  handlePhotoUpdate,
  handlePhotoDelete,
  handleStorageUsage,
  handleInspectionList,
  handleInspectionSave,
  handleInspectionDelete,
  handleInspectionPdfPreviewCreate,
  handleInspectionPdfPreviewGet,
  handleHolidays,
  handleClosedDaysList,
  handleClosedDayCreate,
  handleClosedDayDelete,
  handleParkingList,
  handleParkingCreate,
  handleParkingUpdate,
  handleParkingDelete,
  handleParkingRecognize,
  handleChlorineList,
  handleChlorineCreate,
  handleChlorineUpdate,
  handleChlorineDelete,
} from './lib/reports.js'
import {
  handleEquipmentCategoryList,
  handleEquipmentCategorySave,
  handleEquipmentItemList,
  handleEquipmentItemCreate,
  handleEquipmentItemUpdate,
  handleEquipmentItemDelete,
  handleEquipmentTransactionList,
  handleEquipmentTransactionCreate,
  handleEquipmentTransactionUpdate,
  handleEquipmentTransactionDelete,
  handleEquipmentSuggest,
  handleEquipmentTenantList,
  handleEquipmentTenantUpdate,
  handleEquipmentSignatureUpload,
  handleEquipmentSignatureGet,
  handleEquipmentInstallations,
  handleEquipmentTenantSync,
} from './lib/equipment.js'
import {
  handleDocumentList,
  handleDocumentCategorySuggest,
  handleDocumentCreate,
  handleDocumentUpdate,
  handleDocumentDelete,
  handleDocumentDownload,
  handleDocumentThumbnailGet,
  handleDocumentPreviewToken,
  handleDocumentPdfDelete,
} from './lib/documents.js'
import {
  handleContactList,
  handleContactCategorySuggest,
  handleContactCreate,
  handleContactUpdate,
  handleContactDelete,
  handleContactSync,
} from './lib/contacts.js'
import {
  handleBilmenMasterList,
  handleBilmenMasterCreate,
  handleBilmenMasterUpdate,
  handleBilmenMasterDelete,
  handleBilmenMasterRenumber,
  handleBilmenScheduleList,
  handleBilmenScheduleCreate,
  handleBilmenScheduleUpdate,
  handleBilmenScheduleDelete,
  handleBilmenGenerateCandidates,
  handleBilmenScheduleGenerate,
  handleBilmenMailSettingsGet,
  handleBilmenMailSettingsUpdate,
  handleBilmenMailRecipientList,
  handleBilmenMailRecipientCreate,
  handleBilmenMailRecipientUpdate,
  handleBilmenMailRecipientDelete,
} from './lib/bilmen.js'

// Cloudflare Worker 本体。
// - fetch:    /api/* を処理し、それ以外は静的アセット（Vite ビルド成果物）へフォールバック
// - scheduled: 5分ごとの Cron Trigger でメール取得パイプラインを実行
//   （実際の取得間隔は settings.fetch_interval_minutes で runPipeline 内がゲート）

// ログイン失敗回数の上限とロックアウト期間（総当たり/辞書攻撃対策）。
// IP + ユーザー名の組で数え、上限に達すると一定時間ログインを拒否する。
const LOGIN_MAX_ATTEMPTS = 8
const LOGIN_LOCKOUT_SECONDS = 15 * 60

// POST /api/login — ユーザー名/パスワード認証して JWT を返す
async function handleLogin(req, env) {
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

    // KV が使えない環境（ローカル開発等）でも認証自体は動くよう、binding が
    // 無ければレート制限をスキップする（本番は wrangler.jsonc でバインド済み）。
    const attemptsKv = env?.LOGIN_ATTEMPTS || null
    const ip = req.headers.get('cf-connecting-ip') || 'unknown'
    const attemptKey = `fail:${ip}:${username}`
    if (attemptsKv) {
      const failed = Number(await attemptsKv.get(attemptKey)) || 0
      if (failed >= LOGIN_MAX_ATTEMPTS) {
        return json({ error: '試行回数が多すぎます。しばらくしてから再度お試しください' }, 429)
      }
    }

    const supabaseAdmin = getAdminClient()

    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('id, username, password_hash, display_name, token_version, role')
      .eq('username', username)
      .maybeSingle()

    // ユーザー不在とパスワード不一致は同じメッセージにして、ユーザー名の存在を推測させない
    if (error || !user) {
      if (attemptsKv) {
        const failed = (Number(await attemptsKv.get(attemptKey)) || 0) + 1
        await attemptsKv.put(attemptKey, String(failed), { expirationTtl: LOGIN_LOCKOUT_SECONDS })
      }
      return json({ error: 'ユーザー名またはパスワードが違います' }, 401)
    }

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      if (attemptsKv) {
        const failed = (Number(await attemptsKv.get(attemptKey)) || 0) + 1
        await attemptsKv.put(attemptKey, String(failed), { expirationTtl: LOGIN_LOCKOUT_SECONDS })
      }
      return json({ error: 'ユーザー名またはパスワードが違います' }, 401)
    }

    if (attemptsKv) await attemptsKv.delete(attemptKey)

    // tv（発行時点の token_version）を埋め込む。後日 token_version をインクリメント
    // することで、このトークンを含む当該ユーザーの全トークンを即時失効できる。
    const token = await signJwt(
      {
        sub: user.id,
        username: user.username,
        display_name: user.display_name,
        tv: user.token_version ?? 0,
      },
      SESSION_SECRET
    )

    return json({
      token,
      // role はフロントの画面出し分け（owner は日報のみ・読み取り専用）に使う。
      // 権限判定の正はサーバー側（verifyRequestAuth が毎回DBから引く）で、
      // ここで返す値は表示制御のためのもの。
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        role: user.role || 'staff',
      },
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
    return json({ error: 'メール取得処理に失敗しました' }, 500)
  }
}

// GET /api/tasks — カンバンに表示するタスク一覧（受信日時の新しい順）。ログイン必須。
// アーカイブ済み（archived_at が非 NULL）は除外する（アーカイブ画面で参照）。
// データ面（Supabase REST）は anon キーでの匿名アクセスを全廃したため、
// 読み取りも service role 経由・JWT 認証必須の Worker API に統一する。
async function handleTaskList(req) {
  if (!(await verifyRequestAuth(req))) return json({ error: '認証が必要です' }, 401)
  try {
    const supabase = getAdminClient()
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .is('archived_at', null)
      .order('received_at', { ascending: false })
    if (error) {
      console.error('task-list:', error.message)
      return json({ error: 'タスクの取得に失敗しました' }, 500)
    }
    return json({ tasks: data || [] })
  } catch (err) {
    console.error('task-list 失敗:', err)
    return json({ error: 'タスクの取得に失敗しました' }, 500)
  }
}

// GET /api/archive?assignee=&channel=&q= — アーカイブ済みタスク一覧（アーカイブ日の新しい順）。ログイン必須。
// 担当者（assignee）・情報源（channel）での絞り込みと、フリーワード（q）での全文検索に対応する。
async function handleArchiveList(req) {
  if (!(await verifyRequestAuth(req))) return json({ error: '認証が必要です' }, 401)
  try {
    const params = new URL(req.url).searchParams
    const assignee = (params.get('assignee') || '').trim()
    const channel = (params.get('channel') || '').trim()
    // フリーワードは PostgREST の or() フィルタに直接入るため、区切り記号として
    // 意味を持つ文字（, ( ) % * \）を除去して注入・文法崩れを防ぐ。
    const q = (params.get('q') || '').replace(/[,()%*\\]/g, ' ').trim().slice(0, 100)

    const supabase = getAdminClient()
    let query = supabase
      .from('tasks')
      .select('*')
      .not('archived_at', 'is', null)
      .order('archived_at', { ascending: false })
      .limit(500)
    if (assignee) query = query.eq('assignee', assignee)
    if (channel) query = query.eq('channel', channel)
    if (q) {
      const like = `%${q}%`
      const conditions = [
        `title.ilike.${like}`,
        `subject.ilike.${like}`,
        `body_preview.ilike.${like}`,
        `sender.ilike.${like}`,
        `sender_display.ilike.${like}`,
        `contact.ilike.${like}`,
        `remarks.ilike.${like}`,
      ]
      // タスクID（画面表示は「T-123」）での検索に対応する。「T-123」「t-123」「123」の
      // いずれでも引けるよう、数値部分だけを取り出して task_no の完全一致を条件に加える
      // （task_no は数値カラムなので ilike は使えない）。
      const taskNo = /^\s*[tT]?-?(\d+)\s*$/.exec(q)?.[1]
      if (taskNo) conditions.push(`task_no.eq.${taskNo}`)
      query = query.or(conditions.join(','))
    }
    const { data, error } = await query
    if (error) {
      console.error('archive-list:', error.message)
      return json({ error: 'アーカイブの取得に失敗しました' }, 500)
    }
    return json({ tasks: data || [] })
  } catch (err) {
    console.error('archive-list 失敗:', err)
    return json({ error: 'アーカイブの取得に失敗しました' }, 500)
  }
}

// GET /api/settings — 設定の読み取り（{key: value}）。ログイン必須。
async function handleSettingsRead(req) {
  if (!(await verifyRequestAuth(req))) return json({ error: '認証が必要です' }, 401)
  try {
    const supabase = getAdminClient()
    const { data, error } = await supabase.from('settings').select('key, value')
    if (error) {
      console.error('settings-read:', error.message)
      return json({ error: '設定の取得に失敗しました' }, 500)
    }
    const map = {}
    for (const r of data || []) map[r.key] = r.value
    return json({ settings: map })
  } catch (err) {
    console.error('settings-read 失敗:', err)
    return json({ error: '設定の取得に失敗しました' }, 500)
  }
}

// GET /api/logs — 操作ログ（新しい順・上限200）。ログイン必須。
async function handleLogs(req) {
  if (!(await verifyRequestAuth(req))) return json({ error: '認証が必要です' }, 401)
  try {
    const supabase = getAdminClient()
    const { data, error } = await supabase
      .from('activity_logs')
      .select('id, log_type, actor, message, created_at')
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) {
      console.error('logs:', error.message)
      return json({ error: 'ログの取得に失敗しました' }, 500)
    }
    return json({ logs: data || [] })
  } catch (err) {
    console.error('logs 失敗:', err)
    return json({ error: 'ログの取得に失敗しました' }, 500)
  }
}

// GET /api/usage?month=YYYY-MM — 月次利用量。ログイン必須。
async function handleUsage(req) {
  if (!(await verifyRequestAuth(req))) return json({ error: '認証が必要です' }, 401)
  try {
    const month = new URL(req.url).searchParams.get('month') || ''
    const supabase = getAdminClient()
    const columns =
      'month, input_tokens, output_tokens, calls, fax_calls, fax_input_tokens, fax_output_tokens, parking_calls, updated_at'
    // month 未指定なら全期間の月別データを新しい順で返す（今月・先月・累計の
    // 表示に使う。2026-08-03）。件数は月単位のため増え方が緩やかで、全件返しても軽い。
    if (!month) {
      const { data, error } = await supabase
        .from('api_usage')
        .select(columns)
        .order('month', { ascending: false })
      if (error) {
        console.error('usage(all):', error.message)
        return json({ error: '利用量の取得に失敗しました' }, 500)
      }
      return json({ months: data || [] })
    }
    if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: 'month が不正です' }, 400)
    const { data, error } = await supabase.from('api_usage').select(columns).eq('month', month).maybeSingle()
    if (error) {
      console.error('usage:', error.message)
      return json({ error: '利用量の取得に失敗しました' }, 500)
    }
    return json({ usage: data })
  } catch (err) {
    console.error('usage 失敗:', err)
    return json({ error: '利用量の取得に失敗しました' }, 500)
  }
}

// PUT /api/settings — 設定の保存。ログイン必須。
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
  'archive_after_days',
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
      console.error('settings 保存失敗:', error.message)
      return json({ error: '設定の保存に失敗しました' }, 500)
    }
    return json({ ok: true, saved: rows.map((r) => r.key) })
  } catch (err) {
    console.error('settings 失敗:', err)
    return json({ error: '設定の保存に失敗しました' }, 500)
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
        channel: 'manual',
        title: title.slice(0, 120),
        assignee,
        status,
        due_date: dueDate,
        sender: '手動登録',
        subject: title.slice(0, 120),
        remarks,
        received_at: now,
        completed_at: status === '完了' ? now : null,
        classification_note: `${auth.display_name || auth.username || '不明なユーザー'} が手動で登録しました。`,
      })
      .select()
      .single()
    if (error) {
      console.error('task-create 登録失敗:', error.message)
      return json({ error: 'タスクの登録に失敗しました' }, 500)
    }

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
    return json({ error: 'タスクの登録に失敗しました' }, 500)
  }
}

// PATCH /api/tasks — タスクの担当者・期限・留意事項・タイトル・ステータスの編集。ログイン必須。
// データ面はすべて service role 経由に統一したため、カンバンのステータス変更もここで扱う。
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
    if (typeof payload.status === 'string' && VALID_STATUSES.has(payload.status)) {
      fields.status = payload.status
    }
    // スパム判定。true にした時点で「完了」にしてアーカイブへ即移動する（カードの
    // 「スパム」ボタン用。カンバンから消して視界から外すのが目的のため、ステータス変更と
    // アーカイブをまとめてサーバー側で行う）。false（解除）はフラグだけ戻し、
    // アーカイブから戻すかどうかは利用者がステータス変更で選べるようにする。
    const spamRequested = typeof payload.is_spam === 'boolean' ? payload.is_spam : null
    if (spamRequested !== null) {
      fields.is_spam = spamRequested
      if (spamRequested) {
        const now = new Date().toISOString()
        fields.status = '完了'
        fields.completed_at = now
        fields.archived_at = now
      }
    }
    if (Object.keys(fields).length === 0) {
      return json({ error: '更新できる項目がありません' }, 400)
    }

    const supabase = getAdminClient()

    // ステータス変更時は操作ログに残すため、更新前の値を取得しておく
    let prevStatus = null
    if (fields.status) {
      const { data: before } = await supabase.from('tasks').select('title, status').eq('id', id).maybeSingle()
      prevStatus = before?.status ?? null

      // 完了への遷移で completed_at を記録（アーカイブ移行の起点）。
      // 完了以外へ戻したら completed_at・archived_at をクリアしてカンバンへ復帰させる。
      if (fields.status === '完了') {
        if (prevStatus !== '完了') fields.completed_at = new Date().toISOString()
      } else {
        fields.completed_at = null
        fields.archived_at = null
      }
    }

    const { data, error } = await supabase
      .from('tasks')
      .update(fields)
      .eq('id', id)
      .select()
      .single()
    if (error) {
      console.error('task-update 更新失敗:', error.message)
      return json({ error: 'タスクの更新に失敗しました' }, 500)
    }

    const actorName = auth.display_name || auth.username || '不明なユーザー'
    // スパム判定の付与・解除は、単なるステータス変更とは意味が違うので専用のログを残す
    // （後から「なぜアーカイブされたか」を追えるようにするため）。
    if (spamRequested !== null) {
      await supabase.from('activity_logs').insert({
        log_type: 'status_change',
        actor: actorName,
        message: spamRequested
          ? `「${data.title}」をスパムと判定してアーカイブへ移動`
          : `「${data.title}」のスパム判定を解除`,
        detail: { task_id: id },
      })
    } else if (fields.status && prevStatus && prevStatus !== fields.status) {
      await supabase.from('activity_logs').insert({
        log_type: 'status_change',
        actor: actorName,
        message: `「${data.title}」のステータスを ${prevStatus} → ${fields.status} に変更`,
        detail: { task_id: id },
      })
    }

    return json({ ok: true, task: data })
  } catch (err) {
    console.error('task-update 失敗:', err)
    return json({ error: 'タスクの更新に失敗しました' }, 500)
  }
}

// Gmail のメッセージIDは英数・ハイフン・アンダースコアのみ
const GMAIL_ID_RE = /^[A-Za-z0-9_-]+$/

// GET /api/attachments?thread_id=... （または ?message_id=...）
//   添付ファイル一覧（メタ情報）を返す。ログイン必須。
//   thread_id 指定時はスレッド内の全メッセージの添付を集約して返す（各添付に message_id 付き）。
//   これにより返信で本文が上書きされても、最初・途中の返信の添付が失われずに表示できる。
//   共有アカウントの認証情報で Gmail から取得するため、担当者が Gmail にログインしていなくても参照できる。
// タスクに紐づく Gmail スレッド ID かどうかを検証する。
// 存在しなければ null を返す（タスク化されていない共有メールボックスの
// 任意メッセージまで JWT だけで読めてしまわないよう、常にタスク所属を要求する）。
async function findTaskByThreadId(supabase, threadId) {
  // 同一スレッドに複数タスクが並ぶことがある（FAXは同一送信元・同一件名でGmailが複数を
  // 1スレッドに束ねるため。一意性は gmail_thread_id ではなく gmail_message_id で担保）。
  // そのため maybeSingle（2件以上でエラーになる）ではなく先頭1件を返す。用途はスレッドが
  // いずれかのタスクに属することの確認（認可）と、通常メールの counterpart 解決。
  const { data } = await supabase
    .from('tasks')
    .select('sender, sender_email, gmail_message_id, channel')
    .eq('gmail_thread_id', threadId)
    .limit(1)
  return (data && data[0]) || null
}

// gmail_message_id（現在の一意キー）でタスクを引く。スレッドに複数タスクが並ぶ場合でも
// 対象のメッセージ（＝タスク）を一意に特定できる。
async function findTaskByMessageId(supabase, messageId) {
  const { data } = await supabase
    .from('tasks')
    .select('sender, sender_email, gmail_message_id, gmail_thread_id, channel')
    .eq('gmail_message_id', messageId)
    .maybeSingle()
  return data || null
}

// GET /api/attachments?thread_id=... — 添付ファイル一覧（メタ情報）を返す。ログイン必須。
// タスクに紐づかない共有Gmailの任意スレッドを引けないよう、thread_id は必ず
// tasks.gmail_thread_id に存在するものに限定する（message_id 単体の経路は廃止）。
async function handleListAttachments(req) {
  if (!(await verifyRequestAuth(req))) return json({ error: '認証が必要です' }, 401)
  try {
    const params = new URL(req.url).searchParams
    const threadId = params.get('thread_id') || ''
    const messageId = params.get('message_id') || ''
    if (!threadId || !GMAIL_ID_RE.test(threadId)) return json({ error: 'thread_id が必要です' }, 400)

    const supabase = getAdminClient()
    // まず message_id（一意）でタスクを特定する。FAXは同一スレッドに複数タスクが並ぶため、
    // thread_id だけで引くと対象を一意に定められない（旧 maybeSingle は複数一致でエラーになり
    // 「対象が見つかりません」になっていた）。message_id 未指定の旧クライアント向けに
    // thread_id 経由のフォールバックも残す。
    const task =
      (messageId && GMAIL_ID_RE.test(messageId) ? await findTaskByMessageId(supabase, messageId) : null) ||
      (await findTaskByThreadId(supabase, threadId))
    if (!task) return json({ error: '対象が見つかりません' }, 404)

    const accessToken = await getAccessToken()

    // FAX（件名が「Attached Image」等の定型で共通するため、Gmail側で複数の
    // 別々のFAXが1スレッドにまとまってしまうことがある）は、スレッド集約では
    // なくこのタスクの元になった単一メッセージの添付だけを返す。
    // スレッド集約すると、別のFAXの添付や、送信元アドレスが全FAX共通
    // （複合機のFAXゲートウェイ）で counterpart によるフィルタが効かないため
    // 無関係な添付まで混ざってしまう。
    if (task.channel === 'fax') {
      const attachments = await getMessageAttachments(accessToken, task.gmail_message_id)
      return json({ attachments })
    }

    // 対象タスクの顧客(counterpart)を特定し、同一件名で複数顧客が1スレッドに
    // まとまった場合に、別顧客宛メッセージの添付が混ざらないよう絞り込む。
    let counterpart = ''
    try {
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
  } catch (err) {
    console.error('attachments 一覧取得失敗:', err)
    return json({ error: '添付ファイル一覧の取得に失敗しました' }, 500)
  }
}

// base64url 文字列をバイト列に変換する
function base64UrlToBytes(data) {
  const normalized = (data || '').replace(/-/g, '+').replace(/_/g, '/')
  return new Uint8Array(Buffer.from(normalized, 'base64'))
}

// POST /api/attachment/preview-token — PDFのアプリ内プレビュー用、短時間（120秒）だけ
// 有効な直接アクセストークンを発行する。ログイン必須。
//
// 背景: SafariはBlob URL（アプリ内でfetchして生成する一時URL）のPDFをiframe内に正しく
// 描画できないことがある（WebKitの既知の問題。真っ白になる・1ページ目しか出ない等）。
// 画像はBlob URLで問題なく表示できるためこのままとし、PDFだけ<iframe>にこのトークン
// 付きの/api/attachmentへ直接ナビゲーションさせることで、Safariでも動く通常のHTTPレスポンス
// として（Content-Disposition: inlineで）PDFを返す。
//
// 通常の /api/attachment はAuthorizationヘッダ必須だが、iframeのsrc属性ではヘッダを
// 送れないため、ここで発行する短時間有効なトークンをクエリ文字列で代わりに使う。
// 対象の添付ファイル（thread_id/message_id/attachment_id）に紐づけて署名するため、
// 他の添付ファイルの取得には転用できない。
async function handleAttachmentPreviewToken(req) {
  const auth = await verifyRequestAuth(req)
  if (!auth) return json({ error: '認証が必要です' }, 401)
  try {
    const payload = await req.json().catch(() => null)
    const threadId = typeof payload?.thread_id === 'string' ? payload.thread_id : ''
    const messageId = typeof payload?.message_id === 'string' ? payload.message_id : ''
    const attachmentId = typeof payload?.attachment_id === 'string' ? payload.attachment_id : ''
    if (!threadId || !GMAIL_ID_RE.test(threadId)) return json({ error: 'thread_id が必要です' }, 400)
    if (!GMAIL_ID_RE.test(messageId)) return json({ error: 'message_id が不正です' }, 400)
    if (!attachmentId) return json({ error: 'attachment_id が必要です' }, 400)

    const supabase = getAdminClient()
    const task = await findTaskByThreadId(supabase, threadId)
    if (!task) return json({ error: '対象が見つかりません' }, 404)

    const accessToken = await getAccessToken()
    const threadMeta = await getThreadMessages(accessToken, threadId)
    if (!threadMeta.some((m) => m.id === messageId)) {
      return json({ error: '対象が見つかりません' }, 404)
    }

    const { SESSION_SECRET } = process.env
    if (!SESSION_SECRET) {
      console.error('attachment-preview-token: SESSION_SECRET が設定されていません')
      return json({ error: 'サーバー設定エラーが発生しました' }, 500)
    }
    const token = await signJwt(
      { purpose: 'attachment-preview', threadId, messageId, attachmentId },
      SESSION_SECRET,
      120
    )
    return json({ token })
  } catch (err) {
    console.error('attachment-preview-token 失敗:', err)
    return json({ error: 'プレビュー用URLの発行に失敗しました' }, 500)
  }
}

// GET /api/attachment?thread_id=..&message_id=..&attachment_id=..&filename=..&mime=..[&preview_token=..]
//   添付ファイル本体を返す。ログイン必須。
//   thread_id がタスクに紐づくこと・message_id がそのスレッドに実在することを
//   検証してから取得する（タスク化されていない共有Gmailの任意メッセージを
//   JWTだけで引けてしまわないようにするため）。
//   preview_token（上記handleAttachmentPreviewTokenが発行）が有効かつ対象の
//   thread_id/message_id/attachment_idと一致する場合は、通常のBearer認証の
//   代わりとして受け付ける（iframeのsrc属性はAuthorizationヘッダを送れないため）。
//   その場合はContent-Dispositionをinlineにしてブラウザ内で直接表示できるようにする。
async function handleDownloadAttachment(req) {
  const params = new URL(req.url).searchParams
  const threadId = params.get('thread_id') || ''
  const messageId = params.get('message_id') || ''
  const attachmentId = params.get('attachment_id') || ''
  const previewToken = params.get('preview_token') || ''

  let viaPreviewToken = false
  if (previewToken) {
    const { SESSION_SECRET } = process.env
    const claims = SESSION_SECRET ? await verifyJwt(previewToken, SESSION_SECRET) : null
    viaPreviewToken =
      !!claims &&
      claims.purpose === 'attachment-preview' &&
      claims.threadId === threadId &&
      claims.messageId === messageId &&
      claims.attachmentId === attachmentId
  }
  if (!viaPreviewToken && !(await verifyRequestAuth(req))) {
    return json({ error: '認証が必要です' }, 401)
  }

  try {
    const filename = (params.get('filename') || 'attachment').slice(0, 255)
    const mimeType = params.get('mime') || 'application/octet-stream'
    if (!threadId || !GMAIL_ID_RE.test(threadId)) return json({ error: 'thread_id が必要です' }, 400)
    if (!GMAIL_ID_RE.test(messageId)) return json({ error: 'message_id が不正です' }, 400)
    if (!attachmentId) return json({ error: 'attachment_id が必要です' }, 400)

    const supabase = getAdminClient()
    const task = await findTaskByThreadId(supabase, threadId)
    if (!task) return json({ error: '対象が見つかりません' }, 404)

    const accessToken = await getAccessToken()
    const threadMeta = await getThreadMessages(accessToken, threadId)
    if (!threadMeta.some((m) => m.id === messageId)) {
      return json({ error: '対象が見つかりません' }, 404)
    }

    const { data } = await getAttachmentData(accessToken, messageId, attachmentId)
    const bytes = base64UrlToBytes(data)

    // Content-Disposition のファイル名: ASCII フォールバック + RFC 5987 の UTF-8 指定を併記
    const asciiName = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')
    const encodedName = encodeURIComponent(filename)
    const disposition = viaPreviewToken ? 'inline' : 'attachment'
    const headers = {
      'Content-Type': mimeType,
      'Content-Disposition': `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
      'Cache-Control': 'private, no-store',
    }
    // preview_token経由（アプリ内PDFプレビュー）のときだけ、このレスポンスを
    // 同一オリジンの<iframe>に埋め込めるようにする。通常のレスポンスは
    // withSecurityHeaders が X-Frame-Options: DENY / CSP frame-ancestors 'none' を
    // 付けてフレーム埋め込みを一切禁止するが、それだと自サイト内のプレビューiframeも
    // ブロックされ「接続が拒否されました」になる。ここで自オリジン限定に緩めるヘッダを
    // 事前設定しておくと、withSecurityHeaders 側は既存値を上書きしない（同一オリジン
    // のみ許可＝他サイトからのクリックジャッキングは引き続き防止される）。
    if (viaPreviewToken) {
      headers['X-Frame-Options'] = 'SAMEORIGIN'
      headers['Content-Security-Policy'] = "frame-ancestors 'self'"
    }
    return new Response(bytes, { headers })
  } catch (err) {
    console.error('attachment ダウンロード失敗:', err)
    return json({ error: '添付ファイルの取得に失敗しました' }, 500)
  }
}

// GET /api/push/public-key — Web Push購読作成に必要なVAPID公開鍵を返す。ログイン必須。
// 公開鍵は秘密情報ではないが、未ログインの第三者に機能の有無を晒さないため認証を要求する。
async function handlePushPublicKey(req) {
  if (!(await verifyRequestAuth(req))) return json({ error: '認証が必要です' }, 401)
  const publicKey = process.env.VAPID_PUBLIC_KEY || ''
  if (!publicKey) return json({ error: 'プッシュ通知は未設定です' }, 404)
  return json({ publicKey })
}

// POST /api/push/subscribe — ブラウザのPushSubscriptionを保存する。ログイン必須。
// endpoint は端末（ブラウザインストール）ごとに一意なため、同じ端末からの
// 再購読は upsert で1行に保つ（ユーザーが変わってもその端末の最新の紐付けに更新）。
async function handlePushSubscribe(req) {
  const auth = await verifyRequestAuth(req)
  if (!auth) return json({ error: '認証が必要です' }, 401)
  try {
    const payload = await req.json().catch(() => null)
    const endpoint = typeof payload?.endpoint === 'string' ? payload.endpoint : ''
    const p256dh = typeof payload?.keys?.p256dh === 'string' ? payload.keys.p256dh : ''
    const authSecret = typeof payload?.keys?.auth === 'string' ? payload.keys.auth : ''
    if (!endpoint || !p256dh || !authSecret) {
      return json({ error: 'endpoint / keys.p256dh / keys.auth は必須です' }, 400)
    }

    const supabase = getAdminClient()
    const { error } = await supabase
      .from('push_subscriptions')
      .upsert(
        { user_id: auth.sub, endpoint, p256dh, auth: authSecret },
        { onConflict: 'endpoint' }
      )
    if (error) {
      console.error('push-subscribe 登録失敗:', error.message)
      return json({ error: '通知の登録に失敗しました' }, 500)
    }
    return json({ ok: true })
  } catch (err) {
    console.error('push-subscribe 失敗:', err)
    return json({ error: '通知の登録に失敗しました' }, 500)
  }
}

// POST /api/push/unsubscribe — PushSubscriptionを削除する。ログイン必須。
// 自分（トークンのユーザー）に紐づく購読のみ削除できるよう user_id も突合する。
async function handlePushUnsubscribe(req) {
  const auth = await verifyRequestAuth(req)
  if (!auth) return json({ error: '認証が必要です' }, 401)
  try {
    const payload = await req.json().catch(() => null)
    const endpoint = typeof payload?.endpoint === 'string' ? payload.endpoint : ''
    if (!endpoint) return json({ error: 'endpoint は必須です' }, 400)

    const supabase = getAdminClient()
    const { error } = await supabase
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', endpoint)
      .eq('user_id', auth.sub)
    if (error) {
      console.error('push-unsubscribe 削除失敗:', error.message)
      return json({ error: '通知の解除に失敗しました' }, 500)
    }
    return json({ ok: true })
  } catch (err) {
    console.error('push-unsubscribe 失敗:', err)
    return json({ error: '通知の解除に失敗しました' }, 500)
  }
}

// パスと静的アセットへのルーティング本体。戻り値は fetch() で
// withSecurityHeaders を通してから返す（API・静的アセットの両方に一律適用するため）。
async function route(req, env) {
  const { pathname } = new URL(req.url)

  if (pathname === '/api/login') {
    return req.method === 'POST' ? handleLogin(req, env) : json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/run-fetch') {
    return req.method === 'POST' ? handleRunFetch(req) : json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/settings') {
    if (req.method === 'GET') return handleSettingsRead(req)
    if (req.method === 'PUT' || req.method === 'POST') return handleSettings(req)
    return json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/tasks') {
    if (req.method === 'GET') return handleTaskList(req)
    if (req.method === 'POST') return handleTaskCreate(req)
    if (req.method === 'PATCH' || req.method === 'PUT') return handleTaskUpdate(req)
    return json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/archive') {
    return req.method === 'GET' ? handleArchiveList(req) : json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/logs') {
    return req.method === 'GET' ? handleLogs(req) : json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/usage') {
    return req.method === 'GET' ? handleUsage(req) : json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/attachments') {
    return req.method === 'GET' ? handleListAttachments(req) : json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/attachment') {
    return req.method === 'GET' ? handleDownloadAttachment(req) : json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/attachment/preview-token') {
    return req.method === 'POST' ? handleAttachmentPreviewToken(req) : json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/push/public-key') {
    return req.method === 'GET' ? handlePushPublicKey(req) : json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/push/subscribe') {
    return req.method === 'POST' ? handlePushSubscribe(req) : json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/push/unsubscribe') {
    return req.method === 'POST' ? handlePushUnsubscribe(req) : json({ error: 'Method Not Allowed' }, 405)
  }
  // --- 日報機能（2026-08-04〜。ハンドラは worker/lib/reports.js） ---
  if (pathname === '/api/reports') {
    return req.method === 'GET' ? handleReportList(req) : json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/report') {
    if (req.method === 'GET') return handleReportGet(req)
    if (req.method === 'POST') return handleReportCreate(req)
    if (req.method === 'PATCH') return handleReportUpdate(req)
    if (req.method === 'DELETE') return handleReportDelete(req)
    return json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/report/entries') {
    if (req.method === 'POST') return handleEntryCreate(req)
    if (req.method === 'PATCH') return handleEntryUpdate(req)
    if (req.method === 'DELETE') return handleEntryDelete(req)
    return json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/report/templates') {
    if (req.method === 'GET') return handleTemplateList(req)
    if (req.method === 'PUT') return handleTemplateSave(req)
    return json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/report/photos') {
    if (req.method === 'GET') return handlePhotoList(req)
    if (req.method === 'POST') return handlePhotoUpload(req)
    if (req.method === 'PATCH') return handlePhotoUpdate(req)
    if (req.method === 'DELETE') return handlePhotoDelete(req)
    return json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/report/photo') {
    return req.method === 'GET' ? handlePhotoGet(req) : json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/report/storage') {
    return req.method === 'GET' ? handleStorageUsage(req) : json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/report/inspections') {
    if (req.method === 'GET') return handleInspectionList(req)
    if (req.method === 'POST') return handleInspectionSave(req)
    if (req.method === 'DELETE') return handleInspectionDelete(req)
    return json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/report/holidays') {
    return req.method === 'GET' ? handleHolidays(req) : json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/report/inspection-pdf-preview') {
    if (req.method === 'GET') return handleInspectionPdfPreviewGet(req)
    if (req.method === 'POST') return handleInspectionPdfPreviewCreate(req)
    return json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/report/closed-days') {
    if (req.method === 'GET') return handleClosedDaysList(req)
    if (req.method === 'POST') return handleClosedDayCreate(req)
    if (req.method === 'DELETE') return handleClosedDayDelete(req)
    return json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/report/parking') {
    if (req.method === 'GET') return handleParkingList(req)
    if (req.method === 'POST') return handleParkingCreate(req)
    if (req.method === 'PATCH') return handleParkingUpdate(req)
    if (req.method === 'DELETE') return handleParkingDelete(req)
    return json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/report/parking/recognize') {
    return req.method === 'POST' ? handleParkingRecognize(req) : json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/report/chlorine') {
    if (req.method === 'GET') return handleChlorineList(req)
    if (req.method === 'POST') return handleChlorineCreate(req)
    if (req.method === 'PATCH') return handleChlorineUpdate(req)
    if (req.method === 'DELETE') return handleChlorineDelete(req)
    return json({ error: 'Method Not Allowed' }, 405)
  }

  // --- 備品管理（Phase 1。2026-08-12〜。ハンドラは worker/lib/equipment.js） ---
  if (pathname === '/api/equipment/categories') {
    if (req.method === 'GET') return handleEquipmentCategoryList(req)
    if (req.method === 'PUT') return handleEquipmentCategorySave(req)
    return json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/equipment/items') {
    if (req.method === 'GET') return handleEquipmentItemList(req)
    if (req.method === 'POST') return handleEquipmentItemCreate(req)
    if (req.method === 'PATCH') return handleEquipmentItemUpdate(req)
    if (req.method === 'DELETE') return handleEquipmentItemDelete(req)
    return json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/equipment/transactions') {
    if (req.method === 'GET') return handleEquipmentTransactionList(req)
    if (req.method === 'POST') return handleEquipmentTransactionCreate(req)
    if (req.method === 'PATCH') return handleEquipmentTransactionUpdate(req)
    if (req.method === 'DELETE') return handleEquipmentTransactionDelete(req)
    return json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/equipment/suggest') {
    return req.method === 'GET' ? handleEquipmentSuggest(req) : json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/equipment/tenants') {
    if (req.method === 'GET') return handleEquipmentTenantList(req)
    if (req.method === 'PATCH') return handleEquipmentTenantUpdate(req)
    return json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/equipment/signature') {
    if (req.method === 'GET') return handleEquipmentSignatureGet(req)
    if (req.method === 'POST') return handleEquipmentSignatureUpload(req)
    return json({ error: 'Method Not Allowed' }, 405)
  }
  // --- FileMaker 連携（APIキー認証。JWT不要。docs/equipment-plan.md 6-2・6-3。2026-08-17〜） ---
  if (pathname === '/api/equipment/installations') {
    return req.method === 'GET' ? handleEquipmentInstallations(req, env) : json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/equipment/tenants/sync') {
    return req.method === 'POST' ? handleEquipmentTenantSync(req, env) : json({ error: 'Method Not Allowed' }, 405)
  }

  // --- 雛形ファイル（業務で使う資料テンプレート。2026-08-30〜。ハンドラは worker/lib/documents.js） ---
  if (pathname === '/api/documents') {
    if (req.method === 'GET') return handleDocumentList(req)
    if (req.method === 'POST') return handleDocumentCreate(req)
    if (req.method === 'PUT') return handleDocumentUpdate(req)
    if (req.method === 'DELETE') return handleDocumentDelete(req)
    return json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/documents/suggest') {
    return req.method === 'GET' ? handleDocumentCategorySuggest(req) : json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/documents/download') {
    return req.method === 'GET' ? handleDocumentDownload(req) : json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/documents/thumbnail') {
    return req.method === 'GET' ? handleDocumentThumbnailGet(req) : json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/documents/preview-token') {
    return req.method === 'POST' ? handleDocumentPreviewToken(req) : json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/documents/pdf') {
    return req.method === 'DELETE' ? handleDocumentPdfDelete(req) : json({ error: 'Method Not Allowed' }, 405)
  }

  // --- 連絡帳（顧客の連絡先台帳。2026-08-31〜。ハンドラは worker/lib/contacts.js） ---
  if (pathname === '/api/contacts') {
    if (req.method === 'GET') return handleContactList(req)
    if (req.method === 'POST') return handleContactCreate(req)
    if (req.method === 'PATCH') return handleContactUpdate(req)
    if (req.method === 'DELETE') return handleContactDelete(req)
    return json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/contacts/suggest') {
    return req.method === 'GET' ? handleContactCategorySuggest(req) : json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/contacts/sync') {
    return req.method === 'POST' ? handleContactSync(req) : json({ error: 'Method Not Allowed' }, 405)
  }

  // --- ビルメンテナンス管理（Phase 1。2026-09-02〜。ハンドラは worker/lib/bilmen.js） ---
  if (pathname === '/api/bilmen/masters') {
    if (req.method === 'GET') return handleBilmenMasterList(req)
    if (req.method === 'POST') return handleBilmenMasterCreate(req)
    if (req.method === 'PATCH') return handleBilmenMasterUpdate(req)
    if (req.method === 'DELETE') return handleBilmenMasterDelete(req)
    return json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/bilmen/masters/renumber') {
    return req.method === 'POST' ? handleBilmenMasterRenumber(req) : json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/bilmen/schedules') {
    if (req.method === 'GET') return handleBilmenScheduleList(req)
    if (req.method === 'POST') return handleBilmenScheduleCreate(req)
    if (req.method === 'PATCH') return handleBilmenScheduleUpdate(req)
    if (req.method === 'DELETE') return handleBilmenScheduleDelete(req)
    return json({ error: 'Method Not Allowed' }, 405)
  }
  // 自動作成（5-3）。GET＝候補一覧（対象月に該当する有効なマスタ＋作成済みフラグ）、
  // POST＝選んだマスタから予定を一括生成
  if (pathname === '/api/bilmen/schedules/generate') {
    if (req.method === 'GET') return handleBilmenGenerateCandidates(req)
    if (req.method === 'POST') return handleBilmenScheduleGenerate(req)
    return json({ error: 'Method Not Allowed' }, 405)
  }
  // メール設定（文面・宛先）。owner・equipment_out_staff には GET も含めて一切見せない
  // （worker/lib/bilmen.js の requireMailAccess で判定。10章・13-14）
  if (pathname === '/api/bilmen/mail/settings') {
    if (req.method === 'GET') return handleBilmenMailSettingsGet(req)
    if (req.method === 'PUT') return handleBilmenMailSettingsUpdate(req)
    return json({ error: 'Method Not Allowed' }, 405)
  }
  if (pathname === '/api/bilmen/mail/recipients') {
    if (req.method === 'GET') return handleBilmenMailRecipientList(req)
    if (req.method === 'POST') return handleBilmenMailRecipientCreate(req)
    if (req.method === 'PATCH') return handleBilmenMailRecipientUpdate(req)
    if (req.method === 'DELETE') return handleBilmenMailRecipientDelete(req)
    return json({ error: 'Method Not Allowed' }, 405)
  }

  if (pathname.startsWith('/api/')) {
    return json({ error: 'Not Found' }, 404)
  }

  // 静的アセット（SPA フォールバックは wrangler.jsonc の not_found_handling で処理）
  const assetRes = await env.ASSETS.fetch(req)
  // sw.js と index.html（SPAシェル。/settings 等どのルートでもフォールバックで
  // 配信される）はキャッシュされると更新が届かない。sw.js が新版でも、シェルの
  // index.html が古いままだと参照するJS/CSSバンドルも古いままになり、更新ボタン
  // やロゴタップでリロードしても見た目が変わらない不具合につながる。ハッシュ付き
  // ファイル名のJS/CSS/画像等（Content-Typeがhtml以外）は長期キャッシュのままで良い。
  if (pathname === '/sw.js' || (assetRes.headers.get('content-type') || '').startsWith('text/html')) {
    const headers = new Headers(assetRes.headers)
    headers.set('Cache-Control', 'no-store, no-cache, must-revalidate')
    return new Response(assetRes.body, {
      status: assetRes.status,
      statusText: assetRes.statusText,
      headers,
    })
  }
  return assetRes
}

export default {
  async fetch(req, env) {
    const res = await route(req, env)
    return withSecurityHeaders(res)
  },

  async scheduled(_event, _env, ctx) {
    ctx.waitUntil(
      runPipeline({ force: false })
        .then((summary) => console.log('scheduled fetch 完了:', JSON.stringify(summary)))
        .catch((err) => console.error('scheduled fetch 失敗:', err))
    )
  },
}
