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
import { getAccessToken, createDraft } from './gmail.js'
import { buildMimeMessage } from './mime.js'
import { insertEvent, patchEvent, deleteEvent, writableCalendarId } from './calendar.js'
import { buildBilmenEvent, eventFingerprint, withCalendarState } from './bilmen-calendar.js'

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
  'cycle_pattern, cycle_years, cycle_anchor_year, memo, remark, sort_order, disabled, created_at, updated_at'

const SCHEDULE_COLUMNS =
  'id, work_no, master_id, target_month, plan_date, plan_start, plan_end, title, title_note, content, ' +
  'notice, place, enter_room, notify, jurisdiction, vendor_code, vendor_name, worker_name, prep_note, ' +
  'remark, memo, actual_date, actual_start, actual_end, actual_note, report_confirmed_on, canceled, ' +
  'cancel_reason, google_event_id, google_synced_at, google_synced_hash, sort_order, created_by, created_at, updated_at'

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

// 数年に1回の作業の周期（cycle_years / cycle_anchor_year。5-3-1）。
// 2つは必ずセットで、片方だけ来たら両方 null に倒す（DB の check 制約と同じ扱い）。
// 範囲外の値も制約に弾かれて 500 になるだけなので、ここで落としておく
function cyclePair(payload) {
  const years = Number(payload?.cycle_years)
  const anchor = Number(payload?.cycle_anchor_year)
  const validYears = Number.isInteger(years) && years >= 2 && years <= 50
  const validAnchor = Number.isInteger(anchor) && anchor >= 1900 && anchor <= 2200
  if (!validYears || !validAnchor) return { cycle_years: null, cycle_anchor_year: null }
  return { cycle_years: years, cycle_anchor_year: anchor }
}

// その年が実施年か（毎年の作業は常に true）。src/lib/bilmen.js の同名関数と同じ判定
function isCycleTargetYear(master, year) {
  const years = master?.cycle_years
  const anchor = master?.cycle_anchor_year
  if (!years || !anchor) return true
  // 起点より前の年でも「◯年ごと」の並びに乗っていれば対象（剰余が負にならないよう補正）
  return (((year - anchor) % years) + years) % years === 0
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

// 作業ID（work_no）の自動採番（2026-09-09。13-5「自動採番しない・手入力＋重複チェックのみ」の
// 方針を転換し、手入力（詳細フォームでの新規作成・未確定行への保存）時は日付＋連番で固定採番する
// よう依頼元から変更依頼があった）。形式は移行データと見た目を合わせた W{YYMMDD}-{連番}
// （例: W260909-01）。YYMMDDは作成日（JST）、連番はその日に発行済みの最大値+1で、
// 一度発行したら編集させない（依頼: 「日付＋連番で固定（編集不可）」）。
// 同時作成による衝突は極めて起こりにくいうえ、起きても呼び出し側のunique制約違反(23505)で
// 検知でき、保存し直せば復帰できるため、採番自体に排他制御は設けていない
function jstTodayCompact() {
  const d = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' }) // 'YYYY-MM-DD'
  return d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10) // 'YYMMDD'
}

async function nextBilmenWorkNo(supabase) {
  const prefix = `W${jstTodayCompact()}-`
  const { data, error } = await supabase.from('bilmen_schedules').select('work_no').like('work_no', `${prefix}%`)
  if (error) throw error
  let max = 0
  for (const row of data || []) {
    const n = Number((row.work_no || '').slice(prefix.length))
    if (Number.isInteger(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(2, '0')}`
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
      ...cyclePair(payload),
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
      // 日付未定（plan_date が null）の行は月グループの先頭に出す（5-1）。
      // 一覧は常に予定日付・時刻の昇順にする（2026-09-09。依頼）。同じ日付内の並びが
      // sort_order（移行データの旧並び）任せだと、後から追加した早い時刻の予定が
      // 先に登録済みの遅い時刻の予定より下に来ることがあったため、plan_start を
      // sort_order より先に見る。sort_order・created_at は日付・時刻まで一致した
      // 場合の最終的なタイブレークとしてのみ残す
      .order('plan_date', { ascending: true, nullsFirst: true })
      .order('plan_start', { ascending: true, nullsFirst: true })
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
    // 各行にカレンダーの反映状態（calendar_state。7-2）を付けて返す
    return json({ schedules: (data || []).map(withCalendarState), month, months })
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
    // work_no はここでは組み立てない。自動採番（2026-09-09〜）に一本化し、
    // クライアントから送られてきた値は無視する（作成時は必ず新規発行、更新時は
    // 呼び出し側で「まだ無ければ発行」を判断する。nextBilmenWorkNo 参照）
    row: {
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
    const workNo = await nextBilmenWorkNo(supabase)
    const { data, error: err } = await supabase
      .from('bilmen_schedules')
      .insert({ ...row, work_no: workNo, created_by: auth?.display_name || auth?.username || null })
      .select(SCHEDULE_COLUMNS)
      .single()
    if (err) {
      console.error('bilmen-schedule-create:', err.message)
      if (err.code === '23505') return json({ error: 'この作業IDは既に使われています。もう一度保存してください' }, 409)
      return json({ error: 'メンテナンス予定の登録に失敗しました' }, 500)
    }
    return json({ schedule: withCalendarState(data) })
  } catch (err) {
    console.error('bilmen-schedule-create 失敗:', err)
    return json({ error: 'メンテナンス予定の登録に失敗しました' }, 500)
  }
}

// 一覧上でのその場編集（時刻・入室・報知・実績日時など）で送られてくる部分更新の許可列。
// 詳細モーダルからの保存は全項目を送るので buildScheduleRow を通す。work_no はここに
// 含めない（自動採番に一本化し、一覧・詳細どちらからも直接は書き換えさせない。2026-09-09）
const PATCHABLE_COLUMNS = {
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
    // 詳細フォームからの保存（full）で、まだ作業IDが無い予定（一括自動作成直後の未確定行）
    // なら、ここで初めて発行する。「手動入力」＝この詳細フォームで保存すること、という
    // 整理（一括自動作成そのものは引き続き work_no を入れない。5-3・13-5参照）
    if (payload?.full) {
      const { data: existingRow } = await supabase
        .from('bilmen_schedules')
        .select('work_no')
        .eq('id', id)
        .maybeSingle()
      if (existingRow && !existingRow.work_no) {
        patch.work_no = await nextBilmenWorkNo(supabase)
      }
    }

    const { data, error: err } = await supabase
      .from('bilmen_schedules')
      .update(patch)
      .eq('id', id)
      .select(SCHEDULE_COLUMNS)
      .maybeSingle()
    if (err) {
      console.error('bilmen-schedule-update:', err.message)
      if (err.code === '23505') return json({ error: 'この作業IDは既に使われています。もう一度保存してください' }, 409)
      return json({ error: 'メンテナンス予定の更新に失敗しました' }, 500)
    }
    if (!data) return json({ error: 'メンテナンス予定が見つかりません' }, 404)

    // 中止にした予定がカレンダーに反映済みなら、イベントを消して反映の記録を空に戻す（7-2）。
    // 消せなかったときも予定の保存自体は成功させ、警告だけ返す（中止の記録を失わないため）
    if (data.canceled && data.google_event_id) {
      const removed = await removeScheduleEvent(supabase, data)
      if (removed.error) {
        return json({ schedule: withCalendarState(data), warning: `中止にしましたが、カレンダーの予定を消せませんでした（${removed.error}）。カレンダー側で手動で削除してください` })
      }
      return json({ schedule: withCalendarState(removed.schedule) })
    }
    return json({ schedule: withCalendarState(data) })
  } catch (err) {
    console.error('bilmen-schedule-update 失敗:', err)
    return json({ error: 'メンテナンス予定の更新に失敗しました' }, 500)
  }
}

// DELETE /api/bilmen/schedules?id=…
// カレンダーに反映済みなら、先にイベントを消す（2026-09-29〜。7-2）。**イベントを消せなかったときは
// 予定も消さない**: 予定だけ消えると、カレンダーに行き先の無いイベントが残り、どの予定のものか
// 追えなくなるため（時間をおいてもう一度削除すればよい）
export async function handleBilmenScheduleDelete(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!id) return json({ error: 'id は必須です' }, 400)
    const supabase = getAdminClient()
    const { data: row } = await supabase
      .from('bilmen_schedules')
      .select('id, google_event_id')
      .eq('id', id)
      .maybeSingle()
    if (row?.google_event_id) {
      const removed = await removeScheduleEvent(supabase, row, { clearRow: false })
      if (removed.error) {
        return json({ error: `カレンダーの予定を消せなかったため、削除を取りやめました（${removed.error}）` }, 502)
      }
    }
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

// ============================================================
// 今月の注釈（2026-09-09〜。5-4）
// ============================================================

// GET /api/bilmen/notes?month=YYYY-MM — 対象月の注釈と変更日付（未登録なら空）
export async function handleBilmenMonthlyNoteGet(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const month = new URL(req.url).searchParams.get('month') || ''
    if (!MONTH_PATTERN.test(month)) return json({ error: '対象年月は YYYY-MM 形式で指定してください' }, 400)
    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('bilmen_monthly_notes')
      .select('note, revised_on')
      .eq('target_month', month)
      .maybeSingle()
    if (err) {
      console.error('bilmen-monthly-note-get:', err.message)
      return json({ error: '注釈と変更表記の取得に失敗しました' }, 500)
    }
    return json({ note: data?.note || '', revised_on: data?.revised_on || '' })
  } catch (err) {
    console.error('bilmen-monthly-note-get 失敗:', err)
    return json({ error: '注釈と変更表記の取得に失敗しました' }, 500)
  }
}

// PUT /api/bilmen/notes — 対象月の注釈と変更日付を保存する。
// **両方とも空のときだけ行ごと削除**する（未登録＝ボタンが中立色に戻る）。
// 変更日付だけを入れる（注釈なしで「変更版」とだけ出す）使い方があるため、
// 注釈が空でも変更日付があれば行は残す（2026-09-15。5-4）
export async function handleBilmenMonthlyNoteUpdate(req) {
  const { auth, error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const month = typeof payload?.target_month === 'string' ? payload.target_month : ''
    if (!MONTH_PATTERN.test(month)) return json({ error: '対象年月は YYYY-MM 形式で指定してください' }, 400)
    const note = trimOrNull(payload?.note, 2000)
    const revisedOn = dateOrNull(payload?.revised_on)

    const supabase = getAdminClient()
    if (!note && !revisedOn) {
      const { error: err } = await supabase.from('bilmen_monthly_notes').delete().eq('target_month', month)
      if (err) {
        console.error('bilmen-monthly-note-delete:', err.message)
        return json({ error: '注釈と変更表記の保存に失敗しました' }, 500)
      }
      return json({ note: '', revised_on: '' })
    }
    const { error: err } = await supabase.from('bilmen_monthly_notes').upsert({
      target_month: month,
      note,
      revised_on: revisedOn,
      updated_by: auth?.display_name || auth?.username || null,
    })
    if (err) {
      console.error('bilmen-monthly-note-update:', err.message)
      return json({ error: '注釈と変更表記の保存に失敗しました' }, 500)
    }
    return json({ note: note || '', revised_on: revisedOn || '' })
  } catch (err) {
    console.error('bilmen-monthly-note-update 失敗:', err)
    return json({ error: '注釈と変更表記の保存に失敗しました' }, 500)
  }
}

// GET /api/bilmen/schedules/generate?month=YYYY-MM
// 自動作成モーダルを開いたときの候補一覧。対象月を months に含む有効なマスタを返し、
// 既に同じ月・同じマスタの予定があるものには created:true を立てる（二重作成の防止。5-3）。
// 数年に1回の作業には in_cycle を立て、その年が実施年でなければ false にする
// （2026-09-15。5-3-1。従来は cycle_pattern のメモを人が読んで判断していた）
export async function handleBilmenGenerateCandidates(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const month = new URL(req.url).searchParams.get('month') || ''
    if (!MONTH_PATTERN.test(month)) return json({ error: '対象年月は YYYY-MM 形式で指定してください' }, 400)
    const monthNumber = Number(month.slice(5, 7))
    const year = Number(month.slice(0, 4))

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
      candidates: (masters || []).map((m) => ({
        ...m,
        created: createdIds.has(m.id),
        in_cycle: isCycleTargetYear(m, year),
      })),
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
const MAIL_SETTINGS_COLUMNS = 'id, subject, body, reply_to, updated_at'
const MAIL_RECIPIENT_COLUMNS = 'id, name, email, note, disabled, sort_order, created_at, updated_at'

// 返信先アドレス（2026-09-29〜）は**メールのヘッダーにそのまま入る**ため、宛先より厳しく検証する。
// 空白・改行・カンマ・<>・引用符を含むものを弾くことで、ヘッダーの差し込み（改行で別の
// ヘッダーを足す）や、カンマ区切りで返信先を複数に増やすことを防ぐ
const REPLY_TO_RE = /^[^\s@,<>"]+@[^\s@,<>"]+\.[^\s@,<>"]+$/
function normalizeReplyTo(value) {
  const v = typeof value === 'string' ? value.trim() : ''
  if (!v) return { value: null }
  if (v.length > 200 || !REPLY_TO_RE.test(v)) return { error: '返信先アドレスの形式が正しくありません' }
  return { value: v.toLowerCase() }
}

// GET /api/bilmen/mail/settings — 件名・本文の雛形
export async function handleBilmenMailSettingsGet(req) {
  const { error } = await requireMailAccess(req)
  if (error) return error
  try {
    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('bilmen_mail_settings')
      .select(MAIL_SETTINGS_COLUMNS)
      .eq('id', MAIL_SETTINGS_ID)
      .maybeSingle()
    if (err) {
      console.error('bilmen-mail-settings-get:', err.message)
      return json({ error: 'メール設定の取得に失敗しました' }, 500)
    }
    return json({ settings: data || { id: MAIL_SETTINGS_ID, subject: '', body: '', reply_to: null } })
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
    const replyTo = normalizeReplyTo(payload?.reply_to)
    if (replyTo.error) return json({ error: replyTo.error }, 400)

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('bilmen_mail_settings')
      .upsert({ id: MAIL_SETTINGS_ID, subject, body, reply_to: replyTo.value }, { onConflict: 'id' })
      .select(MAIL_SETTINGS_COLUMNS)
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

// ============================================================
// 案内メール 方式A（Gmail下書きの自動作成・PDF自動添付。Phase 4'。2026-09-29〜）
// ============================================================
//
// POST /api/bilmen/mail/draft（multipart/form-data）
//   month    … 'YYYY-MM'（操作ログ用）
//   subject  … 件名（画面側で変数を展開済みのもの。プレビューと同じ文面を下書きにする）
//   body     … 本文（同上）
//   pdf      … 連絡票PDF（画面側で html2canvas＋jsPDF で作ったもの。8-2）
//
// 共有アドレスの Gmail に「BCC＝有効な宛先全員・連絡票PDF添付」の下書きを作るだけで、
// **送信はしない**（人が Gmail で中身を確かめてから送る。3-5）。
// 宛先は**画面から受け取らずサーバー側でDBから引き直す**（画面の表示と送り先が
// 食い違う余地をなくすため。方式Bの mailto: と同じく、無効にした宛先は含めない）。
// 方式B（mailto:）は残したまま（2026-09-29時点では両方式を実際に試して、どちらにするか・
// 併用するかを依頼元が判断する段階。docs/bilmen-plan.md 3-5）
const DRAFT_PDF_MAX_BYTES = 20 * 1024 * 1024

export async function handleBilmenMailDraftCreate(req) {
  const { auth, error } = await requireMailAccess(req)
  if (error) return error
  try {
    const form = await req.formData().catch(() => null)
    if (!form) return json({ error: 'フォームの受け取りに失敗しました' }, 400)

    const month = String(form.get('month') || '')
    const subject = String(form.get('subject') || '').trim().slice(0, 200)
    const body = String(form.get('body') || '').slice(0, 5000)
    const pdf = form.get('pdf')

    if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: '対象年月が不正です' }, 400)
    if (!subject) return json({ error: '件名が空です。メール設定で件名を登録してください' }, 400)
    if (!body.trim()) return json({ error: '本文が空です。メール設定で本文を登録してください' }, 400)
    if (!pdf || typeof pdf === 'string') return json({ error: '連絡票PDFが添付されていません' }, 400)
    if (pdf.size > DRAFT_PDF_MAX_BYTES) return json({ error: '連絡票PDFが大きすぎます（20MBまで）' }, 400)

    const supabase = getAdminClient()
    const [{ data: recipients, error: recErr }, { data: shared }, { data: mailSettings }] = await Promise.all([
      supabase
        .from('bilmen_mail_recipients')
        .select('name, email')
        .eq('disabled', false)
        .order('sort_order', { ascending: true }),
      supabase.from('settings').select('value').eq('key', 'shared_gmail').maybeSingle(),
      // 返信先（Reply-To）はメール設定から。画面からは受け取らない（宛先と同じ理由）
      supabase.from('bilmen_mail_settings').select('reply_to').eq('id', MAIL_SETTINGS_ID).maybeSingle(),
    ])
    if (recErr) {
      console.error('bilmen-mail-draft recipients:', recErr.message)
      return json({ error: '宛先の取得に失敗しました' }, 500)
    }
    const bcc = (recipients || []).filter((r) => r.email && r.email.trim())
    if (bcc.length === 0) {
      return json({ error: '有効な宛先が登録されていません。メール設定から登録してください' }, 400)
    }

    const filename = String(pdf.name || '').trim() || `作業予定連絡票_${month}.pdf`
    // 保存時に検証済みだが、ヘッダーに入る値なので作る直前にもう一度確かめる
    const replyTo = normalizeReplyTo(mailSettings?.reply_to || '')
    // 返信先は本文の末尾にも書き添える（2026-09-29〜）。Gmail の画面から送ると Gmail がメールを
    // 組み立て直して Reply-To ヘッダーが落ちることを実機で確認したため（docs/bilmen-plan.md 7-3-3）。
    // ヘッダーの Reply-To は害が無いので残す（Gmail が将来引き継ぐようになれば効く）。
    // メールソフト方式（mailto:）は Reply-To が効いたので、この一文は付けない
    const draftBody = replyTo.value
      ? `${body.replace(/\s+$/, '')}\n\nご返信は ${replyTo.value} までお願いいたします。\n`
      : body
    const raw = buildMimeMessage({
      bcc,
      replyTo: replyTo.value ? [{ email: replyTo.value }] : [],
      subject,
      body: draftBody,
      attachment: { filename, contentType: 'application/pdf', bytes: new Uint8Array(await pdf.arrayBuffer()) },
    })

    const accessToken = await getAccessToken()
    const draft = await createDraft(accessToken, raw)

    // Gmail の画面で下書きを開くためのリンク。共有アドレス以外の Google アカウントで
    // ブラウザにログインしていても正しいアカウントの Gmail が開くよう authuser を付ける
    const account = (shared?.value || '').trim()
    const base = `https://mail.google.com/mail/${account ? `?authuser=${encodeURIComponent(account)}` : 'u/0/'}`
    const messageId = draft?.message?.id || ''

    const actor = auth?.display_name || auth?.username || null
    await logBilmen(supabase, actor, `ビルメン: ${month} の案内メールの下書きを作成しました（宛先 ${bcc.length} 件・PDF添付）`, {
      month,
      draft_id: draft?.id || null,
      message_id: messageId || null,
      recipients: bcc.length,
      reply_to: replyTo.value || null,
      pdf_bytes: pdf.size,
    })

    return json({
      draft_id: draft?.id || null,
      message_id: messageId || null,
      recipient_count: bcc.length,
      reply_to: replyTo.value || null,
      filename,
      // 作った下書きを直接開くリンク（Gmail の仕様変更で開けなくなった場合に備えて、
      // 下書きフォルダを開くリンクも一緒に返す）
      draft_url: messageId ? `${base}#drafts?compose=${messageId}` : `${base}#drafts`,
      drafts_url: `${base}#drafts`,
    })
  } catch (err) {
    console.error('bilmen-mail-draft:', err)
    return json({ error: err instanceof Error ? err.message : '下書きの作成に失敗しました' }, 500)
  }
}

// ============================================================
// Google カレンダー反映（Phase 3。2026-09-29〜。docs/bilmen-plan.md 7-2）
// ============================================================
//
// 反映先は settings.calendar_name（中身はカレンダーID eiwa.public@gmail.com＝「栄和共通」）。
// **表示名から引く方式は使わない**（7-2 の注意書き。calendar.js の writableCalendarId 参照）。
//
// 開始月（settings.bilmen_calendar_start_month）より前の月は反映させない。
// 現行は FileMaker → Claris Connect がその月の中旬に翌月分を一括登録しており（2026-09 分は 8/17 に
// 作られていた）、同じ月を本システムからも反映するとイベントが二重になる（7-2「現行の連携方式からの移行」）。
// 本システムからの反映を始める月を決め、Claris Connect 側のフローはその前月の中旬までに止める運用。

const CALENDAR_SYNC_CHUNK = 10 // 1回の呼び出しで反映する件数。外部リクエスト上限（50/回）に収めるため

async function loadCalendarSettings(supabase) {
  const { data } = await supabase
    .from('settings')
    .select('key, value')
    .in('key', ['calendar_name', 'calendar_id_cache', 'bilmen_calendar_start_month'])
  const map = Object.fromEntries((data || []).map((r) => [r.key, r.value]))
  return {
    calendarId: writableCalendarId(map),
    startMonth: MONTH_PATTERN.test(map.bilmen_calendar_start_month || '') ? map.bilmen_calendar_start_month : null,
  }
}

function startMonthError(month, startMonth) {
  if (startMonth && month < startMonth) {
    return `${month.replace('-', '年')}月はカレンダーに反映できません。本システムからの反映は ${startMonth.replace('-', '年')}月分からです（それより前の月は現行の仕組みで登録済みのため、反映すると予定が二重になります）`
  }
  return null
}

function calendarErrorMessage(err) {
  if (err?.isScopeError) return 'カレンダーへの書き込み権限がありません（calendar.events）'
  return err instanceof Error ? err.message : String(err)
}

// 1件をカレンダーへ反映する（イベントIDがあれば更新、無ければ作成）。成功時は DB の反映記録も更新する。
// 反映済みのイベントを人がカレンダー側で消していた場合（404/410）は、作り直す
async function syncScheduleEvent(supabase, accessToken, calendarId, schedule) {
  const event = buildBilmenEvent(schedule)
  let result
  let action
  if (schedule.google_event_id) {
    try {
      result = await patchEvent(accessToken, calendarId, schedule.google_event_id, event)
      action = 'updated'
    } catch (err) {
      if (!err.isGone) throw err
      result = await insertEvent(accessToken, calendarId, event)
      action = 'created'
    }
  } else {
    result = await insertEvent(accessToken, calendarId, event)
    action = 'created'
  }
  const { data, error } = await supabase
    .from('bilmen_schedules')
    .update({
      google_event_id: result?.id || schedule.google_event_id,
      google_synced_at: new Date().toISOString(),
      google_synced_hash: eventFingerprint(schedule),
    })
    .eq('id', schedule.id)
    .select(SCHEDULE_COLUMNS)
    .maybeSingle()
  if (error) throw new Error(`反映の記録に失敗しました: ${error.message}`)
  return { action, schedule: data }
}

// イベントを消し、（clearRow なら）DB の反映記録を空に戻す。失敗しても例外は投げず { error } を返す
async function removeScheduleEvent(supabase, schedule, { clearRow = true } = {}) {
  try {
    const settings = await loadCalendarSettings(supabase)
    if (!settings.calendarId) return { error: '反映先のカレンダーIDが設定されていません' }
    const accessToken = await getAccessToken()
    await deleteEvent(accessToken, settings.calendarId, schedule.google_event_id)
    if (!clearRow) return { schedule }
    const { data, error } = await supabase
      .from('bilmen_schedules')
      .update({ google_event_id: null, google_synced_at: null, google_synced_hash: null })
      .eq('id', schedule.id)
      .select(SCHEDULE_COLUMNS)
      .maybeSingle()
    if (error) return { error: error.message }
    return { schedule: data }
  } catch (err) {
    return { error: calendarErrorMessage(err) }
  }
}

// GET /api/bilmen/calendar — 反映の設定（開始月・反映先が決まっているか）。画面の案内表示用
export async function handleBilmenCalendarSettings(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const settings = await loadCalendarSettings(getAdminClient())
    return json({ start_month: settings.startMonth, calendar_ready: Boolean(settings.calendarId) })
  } catch (err) {
    console.error('bilmen-calendar-settings 失敗:', err)
    return json({ error: 'カレンダー反映の設定の取得に失敗しました' }, 500)
  }
}

// POST /api/bilmen/calendar/schedule — 1件を手動で反映／取り消す（詳細画面から。2026-09-29の依頼）
//   { id, action: 'sync' | 'remove' }
export async function handleBilmenCalendarSchedule(req) {
  const { auth, error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const id = typeof payload?.id === 'string' ? payload.id : ''
    const action = payload?.action === 'remove' ? 'remove' : 'sync'
    // 強制反映（2026-10-06の依頼）。詳細画面フッターの「カレンダーに強制登録／強制更新」から送られ、
    // 反映開始月より前の月でも登録・更新する（Claris Connect 停止後に追加・変更した10月分などのため）。
    // 開始月より前は Claris Connect が登録済みのイベントと二重になりうるが、その判断は画面の確認で利用者に委ねる
    const force = payload?.force === true
    if (!id) return json({ error: 'id は必須です' }, 400)

    const supabase = getAdminClient()
    const { data: schedule } = await supabase.from('bilmen_schedules').select(SCHEDULE_COLUMNS).eq('id', id).maybeSingle()
    if (!schedule) return json({ error: 'メンテナンス予定が見つかりません' }, 404)
    const actor = auth?.display_name || auth?.username || null

    if (action === 'remove') {
      if (!schedule.google_event_id) return json({ schedule: withCalendarState(schedule) })
      const removed = await removeScheduleEvent(supabase, schedule)
      if (removed.error) return json({ error: `カレンダーから削除できませんでした（${removed.error}）` }, 502)
      await logBilmen(supabase, actor, `ビルメン: 「${schedule.title}」をカレンダーから削除しました`, { id, plan_date: schedule.plan_date })
      return json({ schedule: withCalendarState(removed.schedule) })
    }

    if (schedule.canceled) return json({ error: '中止の予定はカレンダーに反映できません' }, 400)
    if (!schedule.plan_date) return json({ error: '予定日付が未定のため、カレンダーに反映できません' }, 400)
    const settings = await loadCalendarSettings(supabase)
    if (!settings.calendarId) return json({ error: '反映先のカレンダーIDが設定されていません' }, 500)
    const guard = startMonthError(schedule.plan_date.slice(0, 7), settings.startMonth)
    if (guard && !force) return json({ error: guard }, 400)

    const accessToken = await getAccessToken()
    const synced = await syncScheduleEvent(supabase, accessToken, settings.calendarId, schedule)
    await logBilmen(
      supabase,
      actor,
      `ビルメン: 「${schedule.title}」（${schedule.plan_date}）をカレンダーに${synced.action === 'created' ? '登録' : '反映'}しました` +
        (force ? '（強制反映）' : ''),
      { id, action: synced.action, force, google_event_id: synced.schedule?.google_event_id || null },
    )
    return json({ schedule: withCalendarState(synced.schedule), action: synced.action })
  } catch (err) {
    console.error('bilmen-calendar-schedule 失敗:', err)
    return json({ error: `カレンダーへの反映に失敗しました（${calendarErrorMessage(err)}）` }, 500)
  }
}

// POST /api/bilmen/calendar/sync — 月まとめ反映 { month }。
// 反映が要る行（未反映・要再反映）を最大 CALENDAR_SYNC_CHUNK 件ずつ処理し、残り件数を返す。
// 画面は remaining が 0 になるか、1件も進まなくなるまで繰り返し呼ぶ（外部リクエスト上限のため分割）。
// 対象は予定日付が入っていて中止でない行（7-2）。失敗した行は飛ばして続け、理由を返す
export async function handleBilmenCalendarSync(req) {
  const { auth, error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const month = typeof payload?.month === 'string' ? payload.month : ''
    if (!MONTH_PATTERN.test(month)) return json({ error: '対象年月が不正です' }, 400)
    // 前の呼び出しで失敗した行は、今回の呼び出しでは飛ばす（同じ行で延々と失敗し続けないように）
    const skipIds = new Set(Array.isArray(payload?.skip_ids) ? payload.skip_ids.filter((v) => typeof v === 'string') : [])

    const supabase = getAdminClient()
    const settings = await loadCalendarSettings(supabase)
    if (!settings.calendarId) return json({ error: '反映先のカレンダーIDが設定されていません' }, 500)
    const guard = startMonthError(month, settings.startMonth)
    if (guard) return json({ error: guard }, 400)

    const [y, m] = month.split('-').map(Number)
    const first = `${month}-01`
    const next = shiftMonth(month, 1)
    const { data: rows, error: err } = await supabase
      .from('bilmen_schedules')
      .select(SCHEDULE_COLUMNS)
      .gte('plan_date', first)
      .lt('plan_date', `${next}-01`)
      .eq('canceled', false)
      .order('plan_date', { ascending: true })
      .order('plan_start', { ascending: true, nullsFirst: true })
    if (err) {
      console.error('bilmen-calendar-sync select:', err.message)
      return json({ error: 'メンテナンス予定の取得に失敗しました' }, 500)
    }
    const pending = (rows || [])
      .map(withCalendarState)
      .filter((r) => (r.calendar_state === 'none' || r.calendar_state === 'stale') && !skipIds.has(r.id))
    const batch = pending.slice(0, CALENDAR_SYNC_CHUNK)

    const result = { created: 0, updated: 0, failed: [] }
    if (batch.length > 0) {
      const accessToken = await getAccessToken()
      for (const row of batch) {
        try {
          const synced = await syncScheduleEvent(supabase, accessToken, settings.calendarId, row)
          result[synced.action] += 1
        } catch (e) {
          result.failed.push({ id: row.id, title: row.title, plan_date: row.plan_date, error: calendarErrorMessage(e) })
          // 権限が無いなら残りも全部失敗するので、ここで打ち切る
          if (e?.isScopeError) break
        }
      }
      const actor = auth?.display_name || auth?.username || null
      await logBilmen(
        supabase,
        actor,
        `ビルメン: ${y}年${m}月の予定をカレンダーに反映しました（登録 ${result.created} 件・更新 ${result.updated} 件・失敗 ${result.failed.length} 件）`,
        { month, ...result },
      )
    }
    return json({ ...result, remaining: Math.max(pending.length - batch.length, 0) })
  } catch (err) {
    console.error('bilmen-calendar-sync 失敗:', err)
    return json({ error: `カレンダーへの反映に失敗しました（${calendarErrorMessage(err)}）` }, 500)
  }
}
