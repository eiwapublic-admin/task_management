// ビルメンテナンス管理（ビルメン）機能の API ハンドラ（Phase 1。2026-09-02〜）。
// 現行 FileMaker「BKB-Mgt / 作業管理」の移行。詳細は docs/bilmen-plan.md 参照。
//
// 権限（同 10章）: staff/admin は読み書き、owner・備品出庫限定ロールは閲覧のみ。
// 「外部に出る操作」（メール送信・カレンダー反映。Phase 3・4）と「データを変える操作」は
// すべて社員のみ、という整理にしてある。
//
// 建物は1棟で確定のため building は持たない（同 13-4）。作業ID（work_no）・作業マスタID
// （master_no）は移行時に現行の値をそのまま継承し、新規分も手入力＋重複チェックのみ
// （自動採番しない。同 13-5）。

import { json, verifyRequestAuth, canWrite } from './http.js'
import { getAdminClient } from './supabase-admin.js'

// メール設定・宛先は「外部に出る操作」の一部として、owner・備品出庫限定ロールには
// 一切見せない（10章・13-14）。canWrite() と同じ判定だが、GET も含めて塞ぐ意図を
// 名前で明示するために別関数にしている
async function requireMailAccess(req) {
  const auth = await verifyRequestAuth(req)
  if (!auth) return { error: json({ error: '認証が必要です' }, 401) }
  if (!canWrite(auth)) return { error: json({ error: 'この操作を行う権限がありません' }, 403) }
  return { auth }
}

const MASTER_COLUMNS =
  'id, master_no, title, title_note, content, notice, place, enter_room, notify, jurisdiction, ' +
  'vendor_code, vendor_name, worker_name, prep_note, plan_start, plan_end, months, day_pattern, ' +
  'cycle_pattern, memo, remark, sort_order, disabled, created_at, updated_at'

const SCHEDULE_COLUMNS =
  'id, work_no, master_id, target_month, plan_date, plan_start, plan_end, title, title_note, content, ' +
  'notice, place, enter_room, notify, jurisdiction, vendor_code, vendor_name, worker_name, prep_note, ' +
  'remark, memo, actual_date, actual_start, actual_end, actual_note, report_confirmed_on, canceled, ' +
  'cancel_reason, google_event_id, google_synced_at, sort_order, created_by, created_at, updated_at'

// 予定の一覧で既定で返す月数（11章。既定は直近12ヶ月、「もっと見る」で遡る）
const DEFAULT_MONTHS = 12
const MAX_MONTHS = 120

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

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

function boolOr(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}

// 'HH:MM'（または 'HH:MM:SS'）だけを受け付け、それ以外は null にする。
// DB は time 型なので、不正な文字列をそのまま渡すと Postgres 側のエラーになってしまう
function timeOrNull(value) {
  if (typeof value !== 'string') return null
  const t = value.trim().slice(0, 5)
  return TIME_PATTERN.test(t) ? t : null
}

function dateOrNull(value) {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return DATE_PATTERN.test(t) ? t : null
}

// 実施月（1〜12）の配列。重複と範囲外を落として昇順にそろえる
function monthsArray(value) {
  if (!Array.isArray(value)) return []
  const set = new Set()
  for (const v of value) {
    const n = Number(v)
    if (Number.isInteger(n) && n >= 1 && n <= 12) set.add(n)
  }
  return [...set].sort((a, b) => a - b)
}

// 'YYYY-MM' を n か月ずらす（src/lib/reports.js の shiftMonth と同じ計算）
function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

// JST の当月 'YYYY-MM'
function currentMonthJst() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' }).slice(0, 7)
}

// 作業ID（work_no）の正規化。前後空白を落とすだけで、体系の妥当性チェックはしない
// （採番規則は「類似の作業を隣同士に揃える」程度の緩いルールのため。13-5）
function normalizeWorkNo(value) {
  return trimOrNull(value, 50)
}

// 外部に影響する操作・一括操作を操作ログに残す（11章）。既存の log_type 制約
// （fetch / status_change / backup）はそのままに、status_change として actor で識別する
// （equipment.js の logEquipmentApiCall と同じ考え方）
async function logBilmen(supabase, actor, message, detail) {
  try {
    await supabase
      .from('activity_logs')
      .insert({ log_type: 'status_change', actor: actor || 'ビルメン', message, detail: detail || null })
  } catch (err) {
    console.error('logBilmen 失敗:', err)
  }
}

// ============================================================
// 作業マスタ
// ============================================================

// GET /api/bilmen/masters?include_disabled=1 — 一覧（表示順 → 作業マスタID順）
export async function handleBilmenMasterList(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const includeDisabled = new URL(req.url).searchParams.get('include_disabled') === '1'
    const supabase = getAdminClient()
    let query = supabase
      .from('bilmen_masters')
      .select(MASTER_COLUMNS)
      .order('sort_order', { ascending: true })
      .order('master_no', { ascending: true })
    if (!includeDisabled) query = query.eq('disabled', false)
    const { data, error: err } = await query
    if (err) {
      console.error('bilmen-master-list:', err.message)
      return json({ error: '作業マスタの取得に失敗しました' }, 500)
    }
    return json({ masters: data || [] })
  } catch (err) {
    console.error('bilmen-master-list 失敗:', err)
    return json({ error: '作業マスタの取得に失敗しました' }, 500)
  }
}

function buildMasterRow(payload) {
  const title = trimOrNull(payload?.title, 200)
  if (!title) return { error: '作業名は必須です' }
  return {
    row: {
      title,
      title_note: trimOrNull(payload?.title_note, 500),
      content: trimOrNull(payload?.content),
      notice: trimOrNull(payload?.notice),
      place: trimOrNull(payload?.place, 200),
      enter_room: boolOr(payload?.enter_room),
      notify: boolOr(payload?.notify),
      jurisdiction: trimOrNull(payload?.jurisdiction, 50),
      vendor_code: trimOrNull(payload?.vendor_code, 50),
      vendor_name: trimOrNull(payload?.vendor_name, 100),
      worker_name: trimOrNull(payload?.worker_name, 100),
      prep_note: trimOrNull(payload?.prep_note),
      plan_start: timeOrNull(payload?.plan_start),
      plan_end: timeOrNull(payload?.plan_end),
      months: monthsArray(payload?.months),
      day_pattern: trimOrNull(payload?.day_pattern, 100),
      cycle_pattern: trimOrNull(payload?.cycle_pattern, 200),
      memo: trimOrNull(payload?.memo),
      remark: trimOrNull(payload?.remark),
      sort_order: Number.isFinite(Number(payload?.sort_order)) ? Number(payload.sort_order) : 999,
      disabled: boolOr(payload?.disabled),
    },
  }
}

// POST /api/bilmen/masters — 追加。作業マスタIDは手入力（現行の値を継承するため自動採番しない）
export async function handleBilmenMasterCreate(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const masterNo = Number(payload?.master_no)
    if (!Number.isInteger(masterNo) || masterNo <= 0) {
      return json({ error: '作業マスタIDは1以上の整数で入力してください' }, 400)
    }
    const { row, error: validationError } = buildMasterRow(payload)
    if (validationError) return json({ error: validationError }, 400)

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('bilmen_masters')
      .insert({ ...row, master_no: masterNo })
      .select(MASTER_COLUMNS)
      .single()
    if (err) {
      console.error('bilmen-master-create:', err.message)
      if (err.code === '23505') return json({ error: 'この作業マスタIDは既に使われています' }, 409)
      return json({ error: '作業マスタの登録に失敗しました' }, 500)
    }
    return json({ master: data })
  } catch (err) {
    console.error('bilmen-master-create 失敗:', err)
    return json({ error: '作業マスタの登録に失敗しました' }, 500)
  }
}

// PATCH /api/bilmen/masters — 更新（作業マスタIDも変更できる。移行時の取り違えを直せるように）
export async function handleBilmenMasterUpdate(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const id = typeof payload?.id === 'string' ? payload.id : ''
    if (!id) return json({ error: 'id は必須です' }, 400)
    const { row, error: validationError } = buildMasterRow(payload)
    if (validationError) return json({ error: validationError }, 400)

    const patch = { ...row }
    if (payload?.master_no !== undefined) {
      const masterNo = Number(payload.master_no)
      if (!Number.isInteger(masterNo) || masterNo <= 0) {
        return json({ error: '作業マスタIDは1以上の整数で入力してください' }, 400)
      }
      patch.master_no = masterNo
    }

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('bilmen_masters')
      .update(patch)
      .eq('id', id)
      .select(MASTER_COLUMNS)
      .maybeSingle()
    if (err) {
      console.error('bilmen-master-update:', err.message)
      if (err.code === '23505') return json({ error: 'この作業マスタIDは既に使われています' }, 409)
      return json({ error: '作業マスタの更新に失敗しました' }, 500)
    }
    if (!data) return json({ error: '作業マスタが見つかりません' }, 404)
    return json({ master: data })
  } catch (err) {
    console.error('bilmen-master-update 失敗:', err)
    return json({ error: '作業マスタの更新に失敗しました' }, 500)
  }
}

// DELETE /api/bilmen/masters?id=… — 削除。過去の予定は master_id が null になるだけで残る
// （schema の on delete set null。予定はマスタの複写を持つため表示・帳票は壊れない。3-2）
export async function handleBilmenMasterDelete(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!id) return json({ error: 'id は必須です' }, 400)
    const supabase = getAdminClient()
    const { error: err } = await supabase.from('bilmen_masters').delete().eq('id', id)
    if (err) {
      console.error('bilmen-master-delete:', err.message)
      return json({ error: '作業マスタの削除に失敗しました' }, 500)
    }
    return json({ ok: true })
  } catch (err) {
    console.error('bilmen-master-delete 失敗:', err)
    return json({ error: '作業マスタの削除に失敗しました' }, 500)
  }
}

// POST /api/bilmen/masters/renumber — 表示順を 10 刻みに振り直す（現行の「表示順を再採番」）。
// 並びは現在の表示順 → 作業マスタID順をそのまま維持する
export async function handleBilmenMasterRenumber(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('bilmen_masters')
      .select('id, sort_order, master_no')
      .order('sort_order', { ascending: true })
      .order('master_no', { ascending: true })
    if (err) {
      console.error('bilmen-master-renumber(select):', err.message)
      return json({ error: '表示順の再採番に失敗しました' }, 500)
    }

    // 既に 10 刻みで並んでいる行は更新しない（updated_at を無用に動かさないため）
    let updated = 0
    for (const [index, master] of (data || []).entries()) {
      const next = (index + 1) * 10
      if (master.sort_order === next) continue
      const { error: updErr } = await supabase.from('bilmen_masters').update({ sort_order: next }).eq('id', master.id)
      if (updErr) {
        console.error('bilmen-master-renumber(update):', updErr.message)
        return json({ error: '表示順の再採番に失敗しました' }, 500)
      }
      updated += 1
    }
    return json({ ok: true, updated })
  } catch (err) {
    console.error('bilmen-master-renumber 失敗:', err)
    return json({ error: '表示順の再採番に失敗しました' }, 500)
  }
}

// ============================================================
// メンテナンス予定・実績
// ============================================================

// GET /api/bilmen/schedules?month=YYYY-MM&months=N&q=…
//   month  … 表示の起点になる月（既定＝JSTの当月）
//   months … その月から遡って何ヶ月分を返すか（既定12。11章の「もっと見る」で増やす）
//   q      … 作業名・作業ID・担当会社・場所のフリーワード
export async function handleBilmenScheduleList(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const params = new URL(req.url).searchParams
    const rawMonth = params.get('month') || ''
    const month = MONTH_PATTERN.test(rawMonth) ? rawMonth : currentMonthJst()
    const rawMonths = Number(params.get('months'))
    const months = Number.isFinite(rawMonths) && rawMonths > 0 ? Math.min(Math.floor(rawMonths), MAX_MONTHS) : DEFAULT_MONTHS
    const q = (params.get('q') || '').trim()

    const supabase = getAdminClient()
    let query = supabase
      .from('bilmen_schedules')
      .select(SCHEDULE_COLUMNS)
      .order('target_month', { ascending: false })
      // 日付未定（plan_date が null）の行は月グループの先頭に出す（5-1）
      .order('plan_date', { ascending: true, nullsFirst: true })
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })

    if (q) {
      // 検索時は月の範囲で絞らず全期間から探す（現行の検索欄と同じ挙動）。
      // PostgREST の or 構文は値にカンマ・括弧を含められないため、あらかじめ除いておく
      const safe = q.replace(/[,()*]/g, ' ').trim()
      if (safe) {
        query = query.or(
          ['title', 'work_no', 'vendor_name', 'place', 'memo', 'actual_note']
            .map((col) => `${col}.ilike.%${safe}%`)
            .join(','),
        )
      }
    } else {
      query = query.lte('target_month', month).gte('target_month', shiftMonth(month, -(months - 1)))
    }

    const { data, error: err } = await query
    if (err) {
      console.error('bilmen-schedule-list:', err.message)
      return json({ error: 'メンテナンス予定の取得に失敗しました' }, 500)
    }
    return json({ schedules: data || [], month, months })
  } catch (err) {
    console.error('bilmen-schedule-list 失敗:', err)
    return json({ error: 'メンテナンス予定の取得に失敗しました' }, 500)
  }
}

// 予定の登録・更新に使う行を組み立てる。作業名は必須（マスタからの複写でも必ず入る）
function buildScheduleRow(payload) {
  const targetMonth = typeof payload?.target_month === 'string' ? payload.target_month.trim() : ''
  if (!MONTH_PATTERN.test(targetMonth)) return { error: '対象年月は YYYY-MM 形式で指定してください' }
  const title = trimOrNull(payload?.title, 200)
  if (!title) return { error: '作業名は必須です' }

  const canceled = boolOr(payload?.canceled)
  const cancelReason = trimOrNull(payload?.cancel_reason)
  // 中止にするなら理由を必須にする（5-2）
  if (canceled && !cancelReason) return { error: '中止にする場合は中止理由を入力してください' }

  return {
    row: {
      work_no: normalizeWorkNo(payload?.work_no),
      master_id: typeof payload?.master_id === 'string' && payload.master_id ? payload.master_id : null,
      target_month: targetMonth,
      plan_date: dateOrNull(payload?.plan_date),
      plan_start: timeOrNull(payload?.plan_start),
      plan_end: timeOrNull(payload?.plan_end),
      title,
      title_note: trimOrNull(payload?.title_note, 500),
      content: trimOrNull(payload?.content),
      notice: trimOrNull(payload?.notice),
      place: trimOrNull(payload?.place, 200),
      enter_room: boolOr(payload?.enter_room),
      notify: boolOr(payload?.notify),
      jurisdiction: trimOrNull(payload?.jurisdiction, 50),
      vendor_code: trimOrNull(payload?.vendor_code, 50),
      vendor_name: trimOrNull(payload?.vendor_name, 100),
      worker_name: trimOrNull(payload?.worker_name, 100),
      prep_note: trimOrNull(payload?.prep_note),
      remark: trimOrNull(payload?.remark),
      memo: trimOrNull(payload?.memo),
      actual_date: dateOrNull(payload?.actual_date),
      actual_start: timeOrNull(payload?.actual_start),
      actual_end: timeOrNull(payload?.actual_end),
      actual_note: trimOrNull(payload?.actual_note),
      report_confirmed_on: dateOrNull(payload?.report_confirmed_on),
      canceled,
      cancel_reason: canceled ? cancelReason : null,
      sort_order: Number.isFinite(Number(payload?.sort_order)) ? Number(payload.sort_order) : 999,
    },
  }
}

// POST /api/bilmen/schedules — 単発の予定を手動追加（一覧の「＋」）
export async function handleBilmenScheduleCreate(req) {
  const { auth, error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const { row, error: validationError } = buildScheduleRow(payload)
    if (validationError) return json({ error: validationError }, 400)

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('bilmen_schedules')
      .insert({ ...row, created_by: auth?.display_name || auth?.username || null })
      .select(SCHEDULE_COLUMNS)
      .single()
    if (err) {
      console.error('bilmen-schedule-create:', err.message)
      if (err.code === '23505') return json({ error: 'この作業IDは既に使われています' }, 409)
      return json({ error: 'メンテナンス予定の登録に失敗しました' }, 500)
    }
    return json({ schedule: data })
  } catch (err) {
    console.error('bilmen-schedule-create 失敗:', err)
    return json({ error: 'メンテナンス予定の登録に失敗しました' }, 500)
  }
}

// 一覧上でのその場編集（時刻・入室・報知・実績日時など）で送られてくる部分更新の許可列。
// 詳細モーダルからの保存は全項目を送るので buildScheduleRow を通す
const PATCHABLE_COLUMNS = {
  work_no: normalizeWorkNo,
  plan_date: dateOrNull,
  plan_start: timeOrNull,
  plan_end: timeOrNull,
  enter_room: (v) => boolOr(v),
  notify: (v) => boolOr(v),
  actual_date: dateOrNull,
  actual_start: timeOrNull,
  actual_end: timeOrNull,
  actual_note: (v) => trimOrNull(v),
  report_confirmed_on: dateOrNull,
  memo: (v) => trimOrNull(v),
}

// PATCH /api/bilmen/schedules — 予定・実績の更新。
// payload に full:true が入っていれば詳細モーダルからの全項目保存、
// そうでなければ一覧のその場編集（送られてきた列だけを更新する）
export async function handleBilmenScheduleUpdate(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const id = typeof payload?.id === 'string' ? payload.id : ''
    if (!id) return json({ error: 'id は必須です' }, 400)

    let patch
    if (payload?.full) {
      const { row, error: validationError } = buildScheduleRow(payload)
      if (validationError) return json({ error: validationError }, 400)
      patch = row
    } else {
      patch = {}
      for (const [key, normalize] of Object.entries(PATCHABLE_COLUMNS)) {
        if (payload[key] !== undefined) patch[key] = normalize(payload[key])
      }
      if (Object.keys(patch).length === 0) return json({ error: '更新する項目がありません' }, 400)
    }

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('bilmen_schedules')
      .update(patch)
      .eq('id', id)
      .select(SCHEDULE_COLUMNS)
      .maybeSingle()
    if (err) {
      console.error('bilmen-schedule-update:', err.message)
      if (err.code === '23505') return json({ error: 'この作業IDは既に使われています' }, 409)
      return json({ error: 'メンテナンス予定の更新に失敗しました' }, 500)
    }
    if (!data) return json({ error: 'メンテナンス予定が見つかりません' }, 404)
    return json({ schedule: data })
  } catch (err) {
    console.error('bilmen-schedule-update 失敗:', err)
    return json({ error: 'メンテナンス予定の更新に失敗しました' }, 500)
  }
}

// DELETE /api/bilmen/schedules?id=…
// ※ カレンダー登録済みのイベント削除は Phase 3（7-2）で足す
export async function handleBilmenScheduleDelete(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!id) return json({ error: 'id は必須です' }, 400)
    const supabase = getAdminClient()
    const { error: err } = await supabase.from('bilmen_schedules').delete().eq('id', id)
    if (err) {
      console.error('bilmen-schedule-delete:', err.message)
      return json({ error: 'メンテナンス予定の削除に失敗しました' }, 500)
    }
    return json({ ok: true })
  } catch (err) {
    console.error('bilmen-schedule-delete 失敗:', err)
    return json({ error: 'メンテナンス予定の削除に失敗しました' }, 500)
  }
}

// GET /api/bilmen/schedules/generate?month=YYYY-MM
// 自動作成モーダルを開いたときの候補一覧。対象月を months に含む有効なマスタを返し、
// 既に同じ月・同じマスタの予定があるものには created:true を立てる（二重作成の防止。5-3）
export async function handleBilmenGenerateCandidates(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const month = new URL(req.url).searchParams.get('month') || ''
    if (!MONTH_PATTERN.test(month)) return json({ error: '対象年月は YYYY-MM 形式で指定してください' }, 400)
    const monthNumber = Number(month.slice(5, 7))

    const supabase = getAdminClient()
    const { data: masters, error: mastersErr } = await supabase
      .from('bilmen_masters')
      .select(MASTER_COLUMNS)
      .eq('disabled', false)
      .contains('months', [monthNumber])
      .order('sort_order', { ascending: true })
      .order('master_no', { ascending: true })
    if (mastersErr) {
      console.error('bilmen-generate-candidates(masters):', mastersErr.message)
      return json({ error: '自動作成の候補取得に失敗しました' }, 500)
    }

    const { data: existing, error: existingErr } = await supabase
      .from('bilmen_schedules')
      .select('master_id')
      .eq('target_month', month)
      .not('master_id', 'is', null)
    if (existingErr) {
      console.error('bilmen-generate-candidates(existing):', existingErr.message)
      return json({ error: '自動作成の候補取得に失敗しました' }, 500)
    }
    const createdIds = new Set((existing || []).map((r) => r.master_id))

    return json({
      month,
      candidates: (masters || []).map((m) => ({ ...m, created: createdIds.has(m.id) })),
    })
  } catch (err) {
    console.error('bilmen-generate-candidates 失敗:', err)
    return json({ error: '自動作成の候補取得に失敗しました' }, 500)
  }
}

// POST /api/bilmen/schedules/generate — 予定の自動作成（{ month, master_ids[] }）。
// マスタの内容を複写した予定を一括生成する（3-2）。予定日付・作業IDは未入力のまま作り、
// 一覧の「未確定」グループで人が埋めて確定する（5-3）。
// 冪等性は DB の制約ではなく API 側で担保する（同じマスタを同月に2回実施するケースが
// 将来ありうるため制約では縛らない。6章）
export async function handleBilmenScheduleGenerate(req) {
  const { auth, error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const month = typeof payload?.month === 'string' ? payload.month.trim() : ''
    if (!MONTH_PATTERN.test(month)) return json({ error: '対象年月は YYYY-MM 形式で指定してください' }, 400)
    const masterIds = Array.isArray(payload?.master_ids) ? payload.master_ids.filter((v) => typeof v === 'string') : []
    if (masterIds.length === 0) return json({ error: '作成する作業を1件以上選んでください' }, 400)

    const supabase = getAdminClient()
    const { data: masters, error: mastersErr } = await supabase
      .from('bilmen_masters')
      .select(MASTER_COLUMNS)
      .in('id', masterIds)
      .order('sort_order', { ascending: true })
      .order('master_no', { ascending: true })
    if (mastersErr) {
      console.error('bilmen-schedule-generate(masters):', mastersErr.message)
      return json({ error: '予定の自動作成に失敗しました' }, 500)
    }
    if (!masters || masters.length === 0) return json({ error: '指定された作業マスタが見つかりません' }, 404)

    // 既に同じ月・同じマスタの予定があるものは飛ばす（画面側でもチェック不可にしているが、
    // 別の利用者が同時に作成した場合に備えてサーバー側でも弾く）
    const { data: existing, error: existingErr } = await supabase
      .from('bilmen_schedules')
      .select('master_id')
      .eq('target_month', month)
      .not('master_id', 'is', null)
    if (existingErr) {
      console.error('bilmen-schedule-generate(existing):', existingErr.message)
      return json({ error: '予定の自動作成に失敗しました' }, 500)
    }
    const createdIds = new Set((existing || []).map((r) => r.master_id))

    const actor = auth?.display_name || auth?.username || null
    const rows = []
    for (const [index, m] of masters.entries()) {
      if (createdIds.has(m.id)) continue
      rows.push({
        // work_no は入れない（＝NULL のまま。自動採番しない。13-5）
        master_id: m.id,
        target_month: month,
        plan_date: null,
        plan_start: m.plan_start,
        plan_end: m.plan_end,
        title: m.title,
        title_note: m.title_note,
        content: m.content,
        notice: m.notice,
        place: m.place,
        enter_room: m.enter_room,
        notify: m.notify,
        jurisdiction: m.jurisdiction,
        vendor_code: m.vendor_code,
        vendor_name: m.vendor_name,
        worker_name: m.worker_name,
        prep_note: m.prep_note,
        remark: m.remark,
        sort_order: (index + 1) * 10,
        created_by: actor,
      })
    }
    const skipped = masters.length - rows.length
    if (rows.length === 0) return json({ created: 0, skipped })

    const { error: insertErr } = await supabase.from('bilmen_schedules').insert(rows)
    if (insertErr) {
      console.error('bilmen-schedule-generate(insert):', insertErr.message)
      return json({ error: '予定の自動作成に失敗しました' }, 500)
    }

    await logBilmen(supabase, actor, `ビルメン: ${month} の予定を ${rows.length} 件自動作成しました`, {
      month,
      created: rows.length,
      skipped,
    })
    return json({ created: rows.length, skipped })
  } catch (err) {
    console.error('bilmen-schedule-generate 失敗:', err)
    return json({ error: '予定の自動作成に失敗しました' }, 500)
  }
}

// ============================================================
// メール設定（文面・宛先）。Phase 4 の一部を先行実装（2026-09-03〜）。
// 現行は雛形が1本（MAINT）のみのため、複数テンプレート管理はせず単一設定行にした
// （bilmen_mail_settings.id='default' 固定）。送信は当面 mailto:（方式B）のみで、
// Gmail下書き作成（方式A。PDF自動添付）は別途 gmail.compose 書き込みの実装が
// 要るため未着手（docs/bilmen-plan.md 3-5・7-3）。
// ============================================================

const MAIL_SETTINGS_ID = 'default'
const MAIL_RECIPIENT_COLUMNS = 'id, name, email, note, disabled, sort_order, created_at, updated_at'

// GET /api/bilmen/mail/settings — 件名・本文の雛形
export async function handleBilmenMailSettingsGet(req) {
  const { error } = await requireMailAccess(req)
  if (error) return error
  try {
    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('bilmen_mail_settings')
      .select('id, subject, body, updated_at')
      .eq('id', MAIL_SETTINGS_ID)
      .maybeSingle()
    if (err) {
      console.error('bilmen-mail-settings-get:', err.message)
      return json({ error: 'メール設定の取得に失敗しました' }, 500)
    }
    return json({ settings: data || { id: MAIL_SETTINGS_ID, subject: '', body: '' } })
  } catch (err) {
    console.error('bilmen-mail-settings-get 失敗:', err)
    return json({ error: 'メール設定の取得に失敗しました' }, 500)
  }
}

// PUT /api/bilmen/mail/settings — 件名・本文の雛形を保存
export async function handleBilmenMailSettingsUpdate(req) {
  const { error } = await requireMailAccess(req)
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const subject = trimOrNull(payload?.subject, 200)
    const body = typeof payload?.body === 'string' ? payload.body.slice(0, 5000) : ''
    if (!subject) return json({ error: '件名は必須です' }, 400)
    if (!body.trim()) return json({ error: '本文は必須です' }, 400)

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('bilmen_mail_settings')
      .upsert({ id: MAIL_SETTINGS_ID, subject, body }, { onConflict: 'id' })
      .select('id, subject, body, updated_at')
      .single()
    if (err) {
      console.error('bilmen-mail-settings-update:', err.message)
      return json({ error: 'メール設定の保存に失敗しました' }, 500)
    }
    return json({ settings: data })
  } catch (err) {
    console.error('bilmen-mail-settings-update 失敗:', err)
    return json({ error: 'メール設定の保存に失敗しました' }, 500)
  }
}

// GET /api/bilmen/mail/recipients — 宛先一覧（有効→無効、表示順）
export async function handleBilmenMailRecipientList(req) {
  const { error } = await requireMailAccess(req)
  if (error) return error
  try {
    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('bilmen_mail_recipients')
      .select(MAIL_RECIPIENT_COLUMNS)
      .order('disabled', { ascending: true })
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
    if (err) {
      console.error('bilmen-mail-recipient-list:', err.message)
      return json({ error: '宛先の取得に失敗しました' }, 500)
    }
    return json({ recipients: data || [] })
  } catch (err) {
    console.error('bilmen-mail-recipient-list 失敗:', err)
    return json({ error: '宛先の取得に失敗しました' }, 500)
  }
}

function buildMailRecipientRow(payload) {
  const name = trimOrNull(payload?.name, 200)
  if (!name) return { error: '宛先名は必須です' }
  const email = trimOrNull(payload?.email, 200)
  if (!email || !email.includes('@')) return { error: 'メールアドレスの形式が正しくありません' }
  return {
    row: {
      name,
      email: email.toLowerCase(),
      note: trimOrNull(payload?.note, 500),
      disabled: boolOr(payload?.disabled),
      sort_order: Number.isFinite(Number(payload?.sort_order)) ? Number(payload.sort_order) : 999,
    },
  }
}

// POST /api/bilmen/mail/recipients — 宛先を追加
export async function handleBilmenMailRecipientCreate(req) {
  const { error } = await requireMailAccess(req)
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const { row, error: buildErr } = buildMailRecipientRow(payload)
    if (buildErr) return json({ error: buildErr }, 400)

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('bilmen_mail_recipients')
      .insert(row)
      .select(MAIL_RECIPIENT_COLUMNS)
      .single()
    if (err) {
      console.error('bilmen-mail-recipient-create:', err.message)
      const dup = err.code === '23505'
      return json({ error: dup ? 'このメールアドレスは既に登録されています' : '宛先の登録に失敗しました' }, dup ? 409 : 500)
    }
    return json({ recipient: data }, 201)
  } catch (err) {
    console.error('bilmen-mail-recipient-create 失敗:', err)
    return json({ error: '宛先の登録に失敗しました' }, 500)
  }
}

// PATCH /api/bilmen/mail/recipients — 宛先を更新
export async function handleBilmenMailRecipientUpdate(req) {
  const { error } = await requireMailAccess(req)
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const id = typeof payload?.id === 'string' ? payload.id : ''
    if (!id) return json({ error: 'id は必須です' }, 400)
    const { row, error: buildErr } = buildMailRecipientRow(payload)
    if (buildErr) return json({ error: buildErr }, 400)

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('bilmen_mail_recipients')
      .update(row)
      .eq('id', id)
      .select(MAIL_RECIPIENT_COLUMNS)
      .single()
    if (err) {
      console.error('bilmen-mail-recipient-update:', err.message)
      const dup = err.code === '23505'
      return json({ error: dup ? 'このメールアドレスは既に登録されています' : '宛先の更新に失敗しました' }, dup ? 409 : 500)
    }
    return json({ recipient: data })
  } catch (err) {
    console.error('bilmen-mail-recipient-update 失敗:', err)
    return json({ error: '宛先の更新に失敗しました' }, 500)
  }
}

// DELETE /api/bilmen/mail/recipients?id=… — 宛先を削除
export async function handleBilmenMailRecipientDelete(req) {
  const { error } = await requireMailAccess(req)
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!id) return json({ error: 'id は必須です' }, 400)
    const supabase = getAdminClient()
    const { error: err } = await supabase.from('bilmen_mail_recipients').delete().eq('id', id)
    if (err) {
      console.error('bilmen-mail-recipient-delete:', err.message)
      return json({ error: '宛先の削除に失敗しました' }, 500)
    }
    return json({ ok: true })
  } catch (err) {
    console.error('bilmen-mail-recipient-delete 失敗:', err)
    return json({ error: '宛先の削除に失敗しました' }, 500)
  }
}
