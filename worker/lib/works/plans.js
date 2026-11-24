// 勤怠管理（eWorks）の予定（Phase 2。docs/eworks-plan.md 7章）
//
//   GET    /api/works/shifts?month=YYYY-MM&staff_id=<uuid|all> … 月の予定（本人は自分の分だけ）
//   POST   /api/works/shifts/generate { month, staff_id? }      … 勤務体系から予定を作る（管理者）
//   POST   /api/works/shifts   { staff_id, work_date, site_id, plan_start, plan_end, note } … 手で追加（管理者）
//   PATCH  /api/works/shifts   { id, … }                        … 手で変更（管理者）
//   DELETE /api/works/shifts?id=…                                … 削除（管理者）
//
// 自動作成のきまり（現行「予定一括作成」と同じ＋保護）:
//   ・その日に有効な勤務体系（適用開始日が最も新しいもの）の曜日別パターンで 1 日 1 件
//   ・曜日別が全部空なら、標準の出退勤パターンを月〜金に入れる
//   ・祝日は入れない（勤務体系の「祝日も予定を入れる」がオンなら入れる）。
//     日報カレンダーの休館日は入れない（スタッフの「休館日も勤務する」がオンなら入れる）。設定の会社休日は入れない
//   ・入社日より前は入れない。在籍（active）のスタッフだけ
//   ・手で追加・変更した日（source='manual'）は上書きしない
import { json } from '../http.js'
import { fetchHolidays } from '../holidays.js'
import { getAdminClient } from '../supabase-admin.js'
import { requireWorks } from './auth.js'
import { log } from './masters.js'
import { pushToStaff } from './push.js'
import { addMonths, dow, monthRange, shiftMinutes, todayJst } from './time.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/

// 日付に有効な勤務体系（schedules は valid_from の昇順）
function scheduleAt(schedules, date) {
  let found = null
  for (const s of schedules) if (s.valid_from <= date) found = s
  return found
}

// 1 人 1 か月分の自動作成の行を組み立てる（DB に触らない。テストしやすいよう分けている）
export function buildStaffMonth({ staff, schedules, patterns, holidays, companyHolidays, closedDays = new Set(), month }) {
  const { from, days } = monthRange(month)
  const rows = []
  let anyScheduleInMonth = false
  const ym = from.slice(0, 7)
  for (let d = 1; d <= days; d++) {
    const date = `${ym}-${String(d).padStart(2, '0')}`
    if (staff.hired_on && date < staff.hired_on) continue
    if (companyHolidays.has(date)) continue
    if (closedDays.has(date) && !staff.closed_day_work) continue
    const sch = scheduleAt(schedules, date)
    if (sch) anyScheduleInMonth = true
    if (holidays[date] && !sch?.holiday_work) continue
    const w = dow(date)
    let pid = sch?.weekday_pattern_ids?.[w] || null
    if (!pid) continue
    const p = patterns.get(pid)
    if (!p) continue
    rows.push({
      work_date: date,
      site_id: sch?.main_site_id || null,
      pattern_id: pid,
      plan_start: p.start_time.slice(0, 5),
      plan_end: p.end_time.slice(0, 5),
      telework: !!p.telework,
    })
  }
  let reason = null
  if (rows.length === 0) {
    if (!schedules.length) reason = '勤務体系が未登録'
    else if (!anyScheduleInMonth) reason = `勤務体系の適用開始日（${schedules[0].valid_from}）より前の月`
    else reason = 'この月に予定の日がない（曜日・祝日・入社日による）'
  }
  return { rows, reason }
}

// 自動作成の予定を作り直す。出勤・退勤の記録（実績）が入っている日は、予定も実績もそのまま残す
//   （以前は DB 関数 works_replace_auto_shifts で月の自動作成分をすべて消していたため、実績まで消えていた。2026-11-24）
//   手で追加・変更した日（source=manual）も今までどおり残す
async function replaceAutoShifts(supabase, staffId, from, to, rows) {
  const { error: e1 } = await supabase
    .from('works_shifts')
    .delete()
    .eq('staff_id', staffId)
    .eq('source', 'auto')
    .gte('work_date', from)
    .lte('work_date', to)
    .is('actual_start', null)
    .is('actual_end', null)
  if (e1) throw e1
  const { data: keep, error: e2 } = await supabase.from('works_shifts').select('work_date').eq('staff_id', staffId).gte('work_date', from).lte('work_date', to)
  if (e2) throw e2
  const taken = new Set((keep || []).map((r) => r.work_date))
  const add = rows.filter((r) => !taken.has(r.work_date)).map((r) => ({ staff_id: staffId, ...r, source: 'auto' }))
  if (!add.length) return 0
  const { error: e3 } = await supabase.from('works_shifts').insert(add)
  if (e3) throw e3
  return add.length
}

async function loadSettings(supabase) {
  const { data } = await supabase.from('works_settings').select('*').eq('id', 1).maybeSingle()
  return data || { break_windows: [{ start: '12:00', end: '13:00' }], company_holidays: [] }
}

// 会社の休日 = 日報カレンダーの休館日（closed_days。タスク管理と共有）＋ 設定の会社休日。{ 日付: 表示名 }
async function companyHolidaysOf(supabase, month, settings) {
  const { from, to } = monthRange(month)
  const { data, error } = await supabase.from('closed_days').select('closed_on').gte('closed_on', from).lte('closed_on', to)
  if (error) throw error
  const out = {}
  for (const r of data || []) out[r.closed_on] = '休館日'
  for (const d of settings.company_holidays || []) if (d.startsWith(month)) out[d] = '会社休日'
  return out
}

async function holidaysOf(month) {
  const all = await fetchHolidays()
  const out = {}
  for (const [d, name] of Object.entries(all)) if (d.startsWith(month)) out[d] = name
  return out
}

// 予定を作る。staffIds を省くと在籍の全員
export async function generateMonth(supabase, month, { staffIds = null, actor = null } = {}) {
  const { from, to } = monthRange(month)
  const settings = await loadSettings(supabase)
  // 祝日が取れないときは作らない（祝日に予定が入ってしまうのを防ぐ）
  const holidays = await holidaysOf(month)
  let q = supabase.from('works_staff').select('id, code, name, status, hired_on, closed_day_work').eq('status', 'active').order('code')
  if (staffIds) q = q.in('id', staffIds)
  const { data: staffList, error: e1 } = await q
  if (e1) throw e1
  const ids = staffList.map((s) => s.id)
  const { data: schedules, error: e2 } = ids.length
    ? await supabase.from('works_staff_schedules').select('*').in('staff_id', ids).lte('valid_from', to).order('valid_from')
    : { data: [] }
  if (e2) throw e2
  // 適用開始日がこの月より後の勤務体系も読む（「未登録」ではなく「適用開始日より前の月」と正しく出すため）
  const { data: later, error: e4 } = ids.length
    ? await supabase.from('works_staff_schedules').select('staff_id, valid_from').in('staff_id', ids).gt('valid_from', to).order('valid_from')
    : { data: [] }
  if (e4) throw e4
  const { data: pats, error: e3 } = await supabase.from('works_shift_patterns').select('id, name, start_time, end_time, telework')
  if (e3) throw e3
  const patterns = new Map(pats.map((p) => [p.id, p]))
  const offDays = await companyHolidaysOf(supabase, month, settings)
  const companyHolidays = new Set(Object.keys(offDays).filter((d) => offDays[d] === '会社休日'))
  const closedDays = new Set(Object.keys(offDays).filter((d) => offDays[d] === '休館日'))

  const created = []
  const skipped = []
  for (const s of staffList) {
    const mine = schedules.filter((x) => x.staff_id === s.id)
    const { rows, reason } = buildStaffMonth({ staff: s, schedules: mine, patterns, holidays, companyHolidays, closedDays, month })
    // この月に使える勤務体系が無いときは、今ある予定に手を付けない（2026-11-24: 予定と実績が消えた不具合の対策）
    if (!mine.length) {
      const next = later.find((x) => x.staff_id === s.id)
      skipped.push({ code: s.code, name: s.name, reason: next ? `勤務体系の適用開始日（${next.valid_from}）より前の月のため、今の予定をそのまま残しました` : '勤務体系が未登録のため、今の予定をそのまま残しました' })
      continue
    }
    const n = await replaceAutoShifts(supabase, s.id, from, to, rows)
    if (reason) skipped.push({ code: s.code, name: s.name, reason })
    else created.push({ code: s.code, name: s.name, days: n })
  }
  await log(supabase, actor ? { user: actor } : null, `${month} の予定を作成: ${created.length} 名${skipped.length ? `（予定なし ${skipped.length} 名）` : ''}`)
  return { month, created, skipped }
}

// Cron（毎日 0:00 JST）から呼ぶ。設定の「予定を作る日」以降で、まだ翌月分を作っていなければ作る
export async function autoCreateNextMonth() {
  const supabase = getAdminClient()
  const settings = await loadSettings(supabase)
  const today = todayJst()
  const next = addMonths(today.slice(0, 7), 1)
  if (Number(today.slice(8, 10)) < (settings.schedule_create_day || 20)) return null
  if (settings.last_auto_month === next) return null
  const result = await generateMonth(supabase, next)
  await supabase.from('works_settings').update({ last_auto_month: next }).eq('id', 1)
  return result
}

export async function handleGenerate(req) {
  const { ctx, error } = await requireWorks(req, { admin: true })
  if (error) return error
  const b = await req.json().catch(() => ({}))
  if (!MONTH_RE.test(String(b.month || ''))) return json({ error: '月が正しくありません' }, 400)
  if (b.staff_id && !UUID_RE.test(b.staff_id)) return json({ error: 'スタッフが正しくありません' }, 400)
  try {
    return json(await generateMonth(getAdminClient(), b.month, { staffIds: b.staff_id ? [b.staff_id] : null, actor: ctx.user }))
  } catch (err) {
    console.error('works generate 失敗:', err)
    return json({ error: `予定を作れませんでした（${err.message || '不明なエラー'}）` }, 500)
  }
}

// 時刻・現場・テレワークのどれかが変わったか（メモだけの変更は本人へ知らせない）
function planChanged(cur, row) {
  if (!cur) return false
  if (row.work_date !== undefined && row.work_date !== cur.work_date) return true
  if (row.plan_start !== undefined && row.plan_start !== cur.plan_start.slice(0, 5)) return true
  if (row.plan_end !== undefined && row.plan_end !== cur.plan_end.slice(0, 5)) return true
  if (row.site_id !== undefined && (row.site_id || null) !== (cur.site_id || null)) return true
  if (row.telework !== undefined && !!row.telework !== !!cur.telework) return true
  return false
}

// 予定変更の本人通知（13-1 の 10）。今日以降の予定だけ。失敗しても保存は止めない
async function notifyPlanChange(supabase, shift, title) {
  try {
    if (!shift?.work_date || shift.work_date < todayJst()) return
    const d = shift.work_date
    await pushToStaff(supabase, shift.staff_id, {
      title,
      body: `${Number(d.slice(5, 7))}月${Number(d.slice(8))}日 ${String(shift.plan_start).slice(0, 5)}〜${String(shift.plan_end).slice(0, 5)}　カレンダーで確かめてください`,
      url: `/calendar?month=${d.slice(0, 7)}`,
    })
  } catch (err) {
    console.error('works 予定変更の通知に失敗:', err)
  }
}

function pickShift(b) {
  const row = {}
  if (b.work_date !== undefined) {
    if (!DATE_RE.test(String(b.work_date))) throw new Error('日付が正しくありません')
    row.work_date = b.work_date
  }
  for (const k of ['plan_start', 'plan_end']) {
    if (b[k] !== undefined) {
      if (!TIME_RE.test(String(b[k]))) throw new Error('時刻が正しくありません')
      row[k] = String(b[k]).slice(0, 5)
    }
  }
  if (row.plan_start && row.plan_end && row.plan_start >= row.plan_end) throw new Error('終了は開始より後にしてください')
  if (b.site_id !== undefined) {
    if (b.site_id && !UUID_RE.test(b.site_id)) throw new Error('現場が正しくありません')
    row.site_id = b.site_id || null
  }
  if (b.telework !== undefined) row.telework = !!b.telework
  if (b.note !== undefined) row.note = b.note ? String(b.note).trim().slice(0, 200) || null : null
  return row
}

export async function handleShifts(req) {
  const { ctx, error } = await requireWorks(req)
  if (error) return error
  const supabase = getAdminClient()
  const url = new URL(req.url)

  if (req.method === 'GET') {
    const month = url.searchParams.get('month')
    if (!MONTH_RE.test(String(month || ''))) return json({ error: '月が正しくありません' }, 400)
    let staffId = url.searchParams.get('staff_id') || (ctx.staff ? ctx.staff.id : 'all')
    if (!ctx.isAdmin) {
      if (!ctx.staff) return json({ error: 'スタッフ情報が紐づいていません。管理者にお問い合わせください' }, 403)
      staffId = ctx.staff.id
    } else if (staffId !== 'all' && !UUID_RE.test(staffId)) {
      return json({ error: 'スタッフが正しくありません' }, 400)
    }
    const { from, to } = monthRange(month)
    let q = supabase
      .from('works_shifts')
      .select('id, staff_id, work_date, site_id, pattern_id, plan_start, plan_end, actual_start, actual_end, telework, source, note, plan_changed_at')
      .gte('work_date', from)
      .lte('work_date', to)
      .order('work_date')
      .order('plan_start')
    if (staffId !== 'all') q = q.eq('staff_id', staffId)
    const settings = await loadSettings(supabase)
    const [{ data: shifts, error: e1 }, holidays, companyHolidays, { data: sites }] = await Promise.all([
      q,
      holidaysOf(month).catch(() => ({})),
      companyHolidaysOf(supabase, month, settings),
      supabase.from('works_sites').select('id, code, name'),
    ])
    if (e1) throw e1
    const staffIds = [...new Set(shifts.map((s) => s.staff_id))]
    const { data: schedules } = staffIds.length
      ? await supabase.from('works_staff_schedules').select('staff_id, valid_from, break_overrides').in('staff_id', staffIds).lte('valid_from', to).order('valid_from')
      : { data: [] }
    const siteMap = new Map((sites || []).map((s) => [s.id, s]))
    const items = shifts.map((s) => {
      const sch = scheduleAt((schedules || []).filter((x) => x.staff_id === s.staff_id), s.work_date)
      const override = (sch?.break_overrides || []).find((o) => o.dow === dow(s.work_date)) || null
      const calc = shiftMinutes(s.plan_start, s.plan_end, { windows: settings.break_windows || [], override })
      const site = siteMap.get(s.site_id)
      return {
        ...s,
        plan_start: s.plan_start.slice(0, 5),
        plan_end: s.plan_end.slice(0, 5),
        actual_start: s.actual_start ? s.actual_start.slice(0, 5) : null,
        actual_end: s.actual_end ? s.actual_end.slice(0, 5) : null,
        site: site ? { code: site.code, name: site.name } : null,
        minutes: calc.minutes,
        break_minutes: calc.breakMinutes,
        warn_no_break: calc.warnNoBreak,
      }
    })
    let staff = null
    if (ctx.isAdmin) {
      const { data } = await supabase.from('works_staff').select('id, code, name, status, punch_method').neq('status', 'retired').order('code')
      staff = data
    }
    return json({
      month,
      staff_id: staffId,
      items,
      holidays,
      company_holidays: companyHolidays,
      staff,
      last_auto_month: ctx.isAdmin ? settings.last_auto_month || null : undefined,
    })
  }

  if (!ctx.isAdmin) return json({ error: 'この操作は eWorks 管理者だけができます' }, 403)
  try {
    if (req.method === 'POST') {
      const b = await req.json().catch(() => ({}))
      if (!UUID_RE.test(String(b.staff_id || ''))) return json({ error: 'スタッフが正しくありません' }, 400)
      const row = pickShift(b)
      if (!row.work_date || !row.plan_start || !row.plan_end) return json({ error: '日付と時刻を入力してください' }, 400)
      const { data, error: e } = await supabase
        .from('works_shifts')
        .insert({ ...row, staff_id: b.staff_id, source: 'manual', created_by: ctx.user.id, plan_changed_at: new Date().toISOString() })
        .select('*')
        .single()
      if (e) throw e
      await log(supabase, ctx, `予定を追加: ${row.work_date} ${row.plan_start}〜${row.plan_end}`)
      await notifyPlanChange(supabase, data, '予定が追加されました')
      return json({ item: data })
    }
    if (req.method === 'PATCH') {
      const b = await req.json().catch(() => ({}))
      if (!UUID_RE.test(String(b.id || ''))) return json({ error: 'id が正しくありません' }, 400)
      const row = pickShift(b)
      const { data: cur } = await supabase.from('works_shifts').select('plan_start, plan_end, site_id, telework, work_date').eq('id', b.id).maybeSingle()
      if (!cur) return json({ error: '予定が見つかりません' }, 404)
      const start = row.plan_start || cur.plan_start.slice(0, 5)
      const end = row.plan_end || cur.plan_end.slice(0, 5)
      if (start >= end) return json({ error: '終了は開始より後にしてください' }, 400)
      // 手で直した予定は、再作成で上書きしないよう manual にする
      const { data, error: e } = await supabase
        .from('works_shifts')
        .update({ ...row, source: 'manual', updated_at: new Date().toISOString(), ...(planChanged(cur, row) ? { plan_changed_at: new Date().toISOString() } : {}) })
        .eq('id', b.id)
        .select('*')
        .single()
      if (e) throw e
      await log(supabase, ctx, `予定を変更: ${data.work_date} ${start}〜${end}`)
      if (planChanged(cur, row)) await notifyPlanChange(supabase, data, '予定が変更されました')
      return json({ item: data })
    }
    if (req.method === 'DELETE') {
      const id = url.searchParams.get('id')
      if (!UUID_RE.test(String(id || ''))) return json({ error: 'id が正しくありません' }, 400)
      const { data, error: e } = await supabase.from('works_shifts').delete().eq('id', id).select('staff_id, work_date, plan_start, plan_end').maybeSingle()
      if (e) throw e
      await log(supabase, ctx, `予定を削除: ${data?.work_date || ''}`)
      if (data) await notifyPlanChange(supabase, data, '予定が取り消されました')
      return json({ ok: true })
    }
  } catch (err) {
    if (err instanceof Error && !err.code) return json({ error: err.message }, 400)
    throw err
  }
  return json({ error: 'Method Not Allowed' }, 405)
}
