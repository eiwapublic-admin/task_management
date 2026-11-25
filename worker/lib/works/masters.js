// 勤怠管理（eWorks）のマスタ API（Phase 1）
//   スタッフ・出退勤パターン・現場・勤務体系・設定
// 一覧は eWorks 管理者だけ（現場スタッフは自分の情報を /api/works/me で受け取る）。
import { json } from '../http.js'
import { getAdminClient } from '../supabase-admin.js'
import { requireWorks } from './auth.js'

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const str = (v) => (v === undefined ? undefined : v === null ? null : String(v).trim() || null)

// 受け取った値を、テーブルごとに許す項目だけに絞って検査する。エラーなら文字列を投げる
const SCHEMAS = {
  works_staff: {
    code: (v) => { const s = str(v); if (!s) throw new Error('担当者コードは必須です'); return s },
    name: (v) => { const s = str(v); if (!s) throw new Error('氏名は必須です'); return s },
    kana: str,
    dept: str,
    hired_on: (v) => { const s = str(v); if (s && !DATE_RE.test(s)) throw new Error('入社日の形式が正しくありません'); return s },
    status: (v) => { if (!['active', 'leave', 'retired'].includes(v)) throw new Error('在籍状態が正しくありません'); return v },
    default_pattern_id: (v) => { const s = str(v); if (s && !UUID_RE.test(s)) throw new Error('出退勤パターンが正しくありません'); return s },
    closed_day_work: (v) => !!v,
    punch_method: (v) => { if (!['qr', 'self', 'proxy'].includes(v)) throw new Error('出退勤の入力方法が正しくありません'); return v },
    report_name: str,
    note: str,
  },
  works_shift_patterns: {
    name: (v) => { const s = str(v); if (!s) throw new Error('タイプ名は必須です'); return s },
    start_time: (v) => { if (!TIME_RE.test(String(v || ''))) throw new Error('出勤予定時刻が正しくありません'); return v },
    end_time: (v) => { if (!TIME_RE.test(String(v || ''))) throw new Error('退勤予定時刻が正しくありません'); return v },
    telework: (v) => !!v,
    active: (v) => !!v,
  },
  works_sites: {
    code: (v) => { const s = str(v); if (!s) throw new Error('作業コードは必須です'); return s },
    name: (v) => { const s = str(v); if (!s) throw new Error('作業名称は必須です'); return s },
    detail: str,
    address: str,
    lat: (v) => (v === '' || v == null ? null : Number(v)),
    lng: (v) => (v === '' || v == null ? null : Number(v)),
    radius_m: (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 10 || n > 5000) throw new Error('許容距離は 10〜5000m で入力してください'); return n },
    active: (v) => !!v,
  },
}

const REQUIRED = new Set(['code', 'name', 'start_time', 'end_time'])

function pick(table, body, { partial }) {
  const schema = SCHEMAS[table]
  const out = {}
  for (const [k, fn] of Object.entries(schema)) {
    if (body[k] === undefined) {
      // 新規登録で必須の項目が無ければここでエラーにする（それ以外は DB の既定値）
      if (!partial && REQUIRED.has(k)) out[k] = fn(undefined)
      continue
    }
    out[k] = fn(body[k])
  }
  return out
}

const ORDER = { works_staff: 'code', works_shift_patterns: 'name', works_sites: 'code' }

// GET/POST/PATCH の共通処理（削除は持たない。使わなくなったものは無効・退職にする）
// 現場の QR の合言葉のハッシュは画面に返さない（発行済みかどうかだけ）
function hideSecret(row) {
  if (!row || !('qr_secret_hash' in row)) return row
  const { qr_secret_hash, ...rest } = row
  return { ...rest, has_qr: !!qr_secret_hash }
}

export async function handleMaster(req, table) {
  const { ctx, error } = await requireWorks(req, { admin: true })
  if (error) return error
  const supabase = getAdminClient()
  try {
    if (req.method === 'GET') {
      const { data, error: e } = await supabase.from(table).select('*').order(ORDER[table])
      if (e) throw e
      return json({ items: data.map(hideSecret) })
    }
    const body = await req.json().catch(() => ({}))
    if (req.method === 'POST') {
      const row = pick(table, body, { partial: false })
      const { data, error: e } = await supabase.from(table).insert(row).select('*').single()
      if (e) return dbError(e)
      await log(supabase, ctx, `${LABEL[table]}を登録: ${row.code || ''} ${row.name}`.trim())
      return json({ item: hideSecret(data) })
    }
    if (req.method === 'PATCH') {
      if (!UUID_RE.test(String(body.id || ''))) return json({ error: 'id が正しくありません' }, 400)
      const row = { ...pick(table, body, { partial: true }), updated_at: new Date().toISOString() }
      const { data, error: e } = await supabase.from(table).update(row).eq('id', body.id).select('*').single()
      if (e) return dbError(e)
      await log(supabase, ctx, `${LABEL[table]}を変更: ${data.code || ''} ${data.name}`.trim())
      return json({ item: hideSecret(data) })
    }
    return json({ error: 'Method Not Allowed' }, 405)
  } catch (err) {
    if (err instanceof Error && !err.code) return json({ error: err.message }, 400)
    console.error(`works ${table} 失敗:`, err)
    return json({ error: '処理に失敗しました' }, 500)
  }
}

const LABEL = { works_staff: 'スタッフ', works_shift_patterns: '出退勤パターン', works_sites: '現場' }

function dbError(e) {
  if (e.code === '23505') return json({ error: '同じコード（名前）がすでに登録されています' }, 409)
  console.error('works db error:', e)
  return json({ error: '保存に失敗しました' }, 500)
}

export async function log(supabase, ctx, message) {
  try {
    await supabase.from('activity_logs').insert({
      log_type: 'status_change',
      actor: ctx?.user?.display_name || ctx?.user?.username || 'eWorks',
      message: `[eWorks] ${message}`,
    })
  } catch (err) {
    console.error('works log 失敗:', err)
  }
}

// GET  /api/works/schedules?staff_id=… — 勤務体系の履歴（新しい順）
// POST /api/works/schedules             — 適用開始日ごとに登録（同じ日があれば上書き）
export async function handleSchedules(req) {
  const { ctx, error } = await requireWorks(req, { admin: true })
  if (error) return error
  const supabase = getAdminClient()
  if (req.method === 'GET') {
    const staffId = new URL(req.url).searchParams.get('staff_id')
    if (!UUID_RE.test(String(staffId || ''))) return json({ error: 'staff_id が正しくありません' }, 400)
    const { data, error: e } = await supabase.from('works_staff_schedules').select('*').eq('staff_id', staffId).order('valid_from', { ascending: false })
    if (e) return dbError(e)
    return json({ items: data })
  }
  if (req.method === 'POST') {
    const b = await req.json().catch(() => ({}))
    if (!UUID_RE.test(String(b.staff_id || ''))) return json({ error: 'スタッフが正しくありません' }, 400)
    if (!DATE_RE.test(String(b.valid_from || ''))) return json({ error: '適用開始日が正しくありません' }, 400)
    const ids = Array.isArray(b.weekday_pattern_ids) ? b.weekday_pattern_ids : []
    if (ids.length !== 7 || ids.some((v) => v && !UUID_RE.test(v))) return json({ error: '曜日別のパターンが正しくありません' }, 400)
    const overrides = Array.isArray(b.break_overrides) ? b.break_overrides : []
    for (const o of overrides) {
      if (!(o && Number.isInteger(o.dow) && o.dow >= 0 && o.dow <= 6 && TIME_RE.test(o.start) && TIME_RE.test(o.end))) {
        return json({ error: '例外休憩が正しくありません' }, 400)
      }
    }
    const row = {
      staff_id: b.staff_id,
      valid_from: b.valid_from,
      main_site_id: b.main_site_id && UUID_RE.test(b.main_site_id) ? b.main_site_id : null,
      weekday_pattern_ids: ids.map((v) => v || null),
      break_overrides: overrides,
      holiday_work: !!b.holiday_work,
      commute_allowance: !!b.commute_allowance,
      updated_at: new Date().toISOString(),
    }
    const { data, error: e } = await supabase.from('works_staff_schedules').upsert(row, { onConflict: 'staff_id,valid_from' }).select('*').single()
    if (e) return dbError(e)
    await log(supabase, ctx, `勤務体系を登録（${b.valid_from} から）`)
    return json({ item: data })
  }
  if (req.method === 'DELETE') {
    const id = new URL(req.url).searchParams.get('id')
    if (!UUID_RE.test(String(id || ''))) return json({ error: 'id が正しくありません' }, 400)
    const { error: e } = await supabase.from('works_staff_schedules').delete().eq('id', id)
    if (e) return dbError(e)
    await log(supabase, ctx, '勤務体系を1件削除')
    return json({ ok: true })
  }
  return json({ error: 'Method Not Allowed' }, 405)
}

// GET/PUT /api/works/settings
export async function handleSettings(req) {
  const { ctx, error } = await requireWorks(req, { admin: true })
  if (error) return error
  const supabase = getAdminClient()
  if (req.method === 'GET') {
    const { data, error: e } = await supabase.from('works_settings').select('*').eq('id', 1).maybeSingle()
    if (e) return dbError(e)
    return json({ settings: data })
  }
  if (req.method === 'PUT') {
    const b = await req.json().catch(() => ({}))
    const windows = Array.isArray(b.break_windows) ? b.break_windows : []
    if (windows.length > 5 || windows.some((w) => !(w && TIME_RE.test(w.start) && TIME_RE.test(w.end) && w.start < w.end))) {
      return json({ error: '休憩時間帯は 5 つまで、開始 < 終了 で入力してください' }, 400)
    }
    const rounding = Number(b.rounding_minutes)
    if (![1, 5, 10, 15, 30, 60].includes(rounding)) return json({ error: '丸め単位が正しくありません' }, 400)
    const day = Number(b.schedule_create_day)
    if (!Number.isInteger(day) || day < 1 || day > 28) return json({ error: '予定作成日は 1〜28 日で入力してください' }, 400)
    const inviteDays = Number(b.invite_valid_days)
    if (!Number.isInteger(inviteDays) || inviteDays < 1 || inviteDays > 30) return json({ error: '招待の有効日数は 1〜30 日で入力してください' }, 400)
    const holidays = (Array.isArray(b.company_holidays) ? b.company_holidays : []).filter((d) => DATE_RE.test(d))
    // 要確認のしきい値（分）と、要確認を出し始める日（Phase 4）
    const rules = {}
    for (const k of ['absent_min', 'late_min', 'early_min', 'no_out_min', 'overtime_min']) {
      const v = Number(b.alert_rules?.[k])
      if (!Number.isInteger(v) || v < 0 || v > 600) return json({ error: '要確認のしきい値は 0〜600 分で入力してください' }, 400)
      rules[k] = v
    }
    if (b.alerts_from && !DATE_RE.test(String(b.alerts_from))) return json({ error: '要確認を出し始める日が正しくありません' }, 400)
    // 労務管理者（スタッフの id。2026-11-25）
    const managers = [...new Set((Array.isArray(b.labor_manager_ids) ? b.labor_manager_ids : []).map(String))]
    if (managers.length > 20 || managers.some((id) => !UUID_RE.test(id))) return json({ error: '労務管理者の指定が正しくありません' }, 400)
    const row = {
      labor_manager_ids: managers,
      alert_rules: rules,
      alerts_from: b.alerts_from || null,
      break_windows: windows.map((w) => ({ start: w.start.slice(0, 5), end: w.end.slice(0, 5) })),
      rounding_minutes: rounding,
      schedule_create_day: day,
      invite_valid_days: inviteDays,
      company_holidays: [...new Set(holidays)].sort(),
      updated_at: new Date().toISOString(),
    }
    const { data, error: e } = await supabase.from('works_settings').update(row).eq('id', 1).select('*').single()
    if (e) return dbError(e)
    await log(supabase, ctx, '設定を変更')
    return json({ settings: data })
  }
  return json({ error: 'Method Not Allowed' }, 405)
}
