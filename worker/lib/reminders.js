// リマインダー機能（2026-09-07〜）。
//
// 経緯: Anthropic APIキーの会社アカウントへの移管作業（有効期限2027-09-07）を機に、
// 「その時になったら内容・目的・手順まで思い出せる自信がない」との依頼を受けて新設した。
// システム運用上、期限のある作業（APIキー更新・年次バックアップ復元ドリル等）を対象に、
// タイトル・期限・通知タイミング（最大2回）・詳細・対応の要領・対応済みフラグを管理し、
// 指定した通知タイミングでWeb Pushを送る。通知をタップするとそのリマインダーへ直接
// ジャンプできる（url: /reminders/:id。sw.js は data.url を汎用的に開く）。
//
// 権限: contacts.js と同じ形（staff/adminは読み書き、owner・備品出庫限定ロールは対象外＝
// システムの運用管理そのものであり、閲覧させる意味も無いため RequireStaff で画面ごと隠す）。

import { json, verifyRequestAuth, canWrite } from './http.js'
import { getAdminClient } from './supabase-admin.js'
import { notifyReminder } from './push.js'

const REMINDER_COLUMNS =
  'id, title, due_date, notify_date_1, notify_date_2, detail, how_to, done, done_at, ' +
  'notified_1_at, notified_2_at, created_at, updated_at'

async function requireAuth(req, { write = false } = {}) {
  const auth = await verifyRequestAuth(req)
  if (!auth) return { error: json({ error: '認証が必要です' }, 401) }
  if (write && !canWrite(auth)) {
    return { error: json({ error: 'この操作を行う権限がありません' }, 403) }
  }
  return { auth }
}

function trimOrNull(value, max = 2000) {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t ? t.slice(0, max) : null
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function parseDateOrError(value, label) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return { error: `${label}の形式が正しくありません` }
  return { value }
}

// GET /api/reminders — 一覧（期限日の昇順。未対応/対応済みの絞り込みは画面側で行う）
export async function handleReminderList(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('reminders')
      .select(REMINDER_COLUMNS)
      .order('due_date', { ascending: true })
    if (err) {
      console.error('reminder-list:', err.message)
      return json({ error: 'リマインダーの取得に失敗しました' }, 500)
    }
    return json({ reminders: data || [] })
  } catch (err) {
    console.error('reminder-list 失敗:', err)
    return json({ error: 'リマインダーの取得に失敗しました' }, 500)
  }
}

// GET /api/reminders/:id 相当（クエリ ?id=）。通知からのジャンプ先で、一覧を待たず
// 該当1件だけをすぐ表示できるようにする
export async function handleReminderGet(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!id) return json({ error: 'id は必須です' }, 400)
    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('reminders')
      .select(REMINDER_COLUMNS)
      .eq('id', id)
      .maybeSingle()
    if (err) {
      console.error('reminder-get:', err.message)
      return json({ error: 'リマインダーの取得に失敗しました' }, 500)
    }
    if (!data) return json({ error: 'リマインダーが見つかりません' }, 404)
    return json({ reminder: data })
  } catch (err) {
    console.error('reminder-get 失敗:', err)
    return json({ error: 'リマインダーの取得に失敗しました' }, 500)
  }
}

function buildReminderRow(payload) {
  const title = trimOrNull(payload?.title, 200)
  if (!title) return { error: 'タイトルは必須です' }

  const due = parseDateOrError(payload?.due_date, '期限日付')
  if (due.error) return { error: due.error }

  const notify1 = parseDateOrError(payload?.notify_date_1, '通知タイミング（1回目）')
  if (notify1.error) return { error: notify1.error }

  if (notify1.value > due.value) return { error: '通知タイミング（1回目）は期限日付より前にしてください' }

  let notify2 = null
  if (payload?.notify_date_2) {
    const n2 = parseDateOrError(payload.notify_date_2, '通知タイミング（2回目）')
    if (n2.error) return { error: n2.error }
    if (n2.value > due.value) return { error: '通知タイミング（2回目）は期限日付より前にしてください' }
    if (n2.value < notify1.value) return { error: '通知タイミング（2回目）は1回目より後にしてください' }
    notify2 = n2.value
  }

  return {
    row: {
      title,
      due_date: due.value,
      notify_date_1: notify1.value,
      notify_date_2: notify2,
      detail: trimOrNull(payload?.detail, 4000),
      how_to: trimOrNull(payload?.how_to, 4000),
    },
  }
}

// POST /api/reminders — 新規登録
export async function handleReminderCreate(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const { row, error: validationError } = buildReminderRow(payload)
    if (validationError) return json({ error: validationError }, 400)

    const supabase = getAdminClient()
    const { data, error: err } = await supabase.from('reminders').insert(row).select(REMINDER_COLUMNS).single()
    if (err) {
      console.error('reminder-create:', err.message)
      return json({ error: 'リマインダーの登録に失敗しました' }, 500)
    }
    return json({ reminder: data })
  } catch (err) {
    console.error('reminder-create 失敗:', err)
    return json({ error: 'リマインダーの登録に失敗しました' }, 500)
  }
}

// PATCH /api/reminders — 修正・対応済み切替
// 対応済みへ切り替えるだけの操作（{id, done:true}）にも対応する（本文の再入力は不要にする）
export async function handleReminderUpdate(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const id = typeof payload?.id === 'string' ? payload.id : ''
    if (!id) return json({ error: 'id は必須です' }, 400)

    // 対応済みフラグの切替のみのリクエスト（他フィールドが含まれない）は本文検証をスキップする
    const isFlagOnly = payload && typeof payload.done === 'boolean' && Object.keys(payload).length === 2
    let row
    if (isFlagOnly) {
      row = { done: payload.done, done_at: payload.done ? new Date().toISOString() : null }
    } else {
      const built = buildReminderRow(payload)
      if (built.error) return json({ error: built.error }, 400)
      row = built.row
      if (typeof payload.done === 'boolean') {
        row.done = payload.done
        row.done_at = payload.done ? new Date().toISOString() : null
      }
    }

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('reminders')
      .update(row)
      .eq('id', id)
      .select(REMINDER_COLUMNS)
      .maybeSingle()
    if (err) {
      console.error('reminder-update:', err.message)
      return json({ error: 'リマインダーの更新に失敗しました' }, 500)
    }
    if (!data) return json({ error: 'リマインダーが見つかりません' }, 404)
    return json({ reminder: data })
  } catch (err) {
    console.error('reminder-update 失敗:', err)
    return json({ error: 'リマインダーの更新に失敗しました' }, 500)
  }
}

// DELETE /api/reminders?id=…
export async function handleReminderDelete(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!id) return json({ error: 'id は必須です' }, 400)
    const supabase = getAdminClient()
    const { error: err } = await supabase.from('reminders').delete().eq('id', id)
    if (err) {
      console.error('reminder-delete:', err.message)
      return json({ error: 'リマインダーの削除に失敗しました' }, 500)
    }
    return json({ ok: true })
  } catch (err) {
    console.error('reminder-delete 失敗:', err)
    return json({ error: 'リマインダーの削除に失敗しました' }, 500)
  }
}

// JST基準の「今日」（YYYY-MM-DD）
function todayJSTDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
}

// 通知タイミングが来ているリマインダーへWeb Pushを送る（cronから1日1回呼ぶ）。
// 「その日ちょうど」ではなく「その日以降でまだ送っていなければ送る」判定にする
// （Workerが落ちていた等で当日に送れなかった場合の取りこぼしを防ぐ、9章のサブリクエスト
// 予算と同じ考え方）。対応済みのリマインダーは対象外。
export async function checkReminderNotifications(supabase) {
  const today = todayJSTDate()
  const { data, error } = await supabase
    .from('reminders')
    .select('id, title, due_date, notify_date_1, notify_date_2, notified_1_at, notified_2_at, done')
    .eq('done', false)
    .lte('notify_date_1', today)
  if (error) {
    console.error('reminder-notify(select):', error.message)
    return
  }
  for (const r of data || []) {
    try {
      if (!r.notified_1_at) {
        await notifyReminder({ id: r.id, title: r.title, dueDate: r.due_date })
        await supabase.from('reminders').update({ notified_1_at: new Date().toISOString() }).eq('id', r.id)
      } else if (r.notify_date_2 && r.notify_date_2 <= today && !r.notified_2_at) {
        await notifyReminder({ id: r.id, title: r.title, dueDate: r.due_date })
        await supabase.from('reminders').update({ notified_2_at: new Date().toISOString() }).eq('id', r.id)
      }
    } catch (err) {
      console.error('reminder-notify(send):', r.id, err)
    }
  }
}
