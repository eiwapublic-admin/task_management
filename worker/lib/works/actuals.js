// 出退勤の実績の直接入力（2026-11-20 依頼元の要望）。
//   スタッフごとの入力方法（works_staff.punch_method）: qr＝本人が QR をかざす／self＝本人が時刻を入力／proxy＝管理者が代理入力
//   POST /api/works/actuals        { shift_id, start, end }          … 1 件の勤務の出勤・退勤の時刻（'HH:MM'。空文字で消す）
//   POST /api/works/actuals/plan   { shift_id } | { staff_id, month } … 予定どおりの時刻を入れる（1 件／1 か月分の未入力の日）
// 管理者は誰の分でも、入力方法が self の本人は自分の分だけ入力できる。入力は打刻の記録（works_punches）にも残す。
// 日報（タスク管理）を保存すると、日報の担当名（works_staff.report_name）のスタッフのその日の勤務に時刻を写す（syncFromReport）。
import { json } from '../http.js'
import { getAdminClient } from '../supabase-admin.js'
import { requireWorks } from './auth.js'
import { log } from './masters.js'
import { adoptedTime, monthRange, todayJst } from './time.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const MONTH_RE = /^\d{4}-\d{2}$/
const hm = (t) => (t ? String(t).slice(0, 5) : null)

// 入力してよい人か（管理者、または入力方法が self の本人）
async function canInput(supabase, ctx, staffId) {
  if (ctx.isAdmin) return true
  if (!ctx.staff || ctx.staff.id !== staffId) return false
  const { data } = await supabase.from('works_staff').select('punch_method').eq('id', staffId).maybeSingle()
  return data?.punch_method === 'self'
}

// 勤務 1 件の実績を書き換え、変わった分を打刻の記録に残す
export async function writeActual(supabase, shift, { start, end }, { method, actorId = null, note = null }) {
  const patch = {}
  if (start !== undefined && hm(shift.actual_start) !== start) patch.actual_start = start
  if (end !== undefined && hm(shift.actual_end) !== end) patch.actual_end = end
  if (!Object.keys(patch).length) return false
  const { error } = await supabase.from('works_shifts').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', shift.id)
  if (error) throw error
  const rows = []
  for (const [col, kind] of [['actual_start', 'in'], ['actual_end', 'out']]) {
    if (!(col in patch)) continue
    const t = patch[col]
    rows.push({
      staff_id: shift.staff_id,
      work_date: shift.work_date,
      kind,
      punched_at: new Date(`${shift.work_date}T${t || '00:00'}:00+09:00`).toISOString(),
      method,
      shift_id: shift.id,
      site_id: shift.site_id || null,
      adopted: t,
      flags: [method === 'report' ? 'report' : method === 'correction' ? 'correction' : 'manual'],
      note: t ? note : `${kind === 'in' ? '出勤' : '退勤'}の時刻を消去${note ? `（${note}）` : ''}`,
      created_by: actorId,
    })
  }
  const { error: e2 } = await supabase.from('works_punches').insert(rows)
  if (e2) throw e2
  return true
}

const SHIFT_COLS = 'id, staff_id, work_date, site_id, plan_start, plan_end, actual_start, actual_end, telework'

export async function handleActuals(req) {
  const { ctx, error } = await requireWorks(req)
  if (error) return error
  const supabase = getAdminClient()
  try {
    const b = await req.json().catch(() => ({}))
    if (!UUID_RE.test(String(b.shift_id || ''))) return json({ error: '勤務が正しくありません' }, 400)
    const norm = (v) => (v === '' || v === null ? null : v)
    const start = b.start === undefined ? undefined : norm(b.start)
    const end = b.end === undefined ? undefined : norm(b.end)
    for (const t of [start, end]) if (t && !TIME_RE.test(t)) return json({ error: '時刻は 09:00 のように入力してください' }, 400)
    const { data: shift } = await supabase.from('works_shifts').select(SHIFT_COLS).eq('id', b.shift_id).maybeSingle()
    if (!shift) return json({ error: '勤務が見つかりません' }, 404)
    if (!(await canInput(supabase, ctx, shift.staff_id))) return json({ error: 'この勤務の時刻は入力できません' }, 403)
    if (!ctx.isAdmin && shift.work_date > todayJst()) return json({ error: '先の日の実績は入力できません' }, 400)
    const s = start === undefined ? hm(shift.actual_start) : start
    const e = end === undefined ? hm(shift.actual_end) : end
    if (s && e && e <= s) return json({ error: '退勤は出勤より後の時刻にしてください' }, 400)
    const note = ctx.isAdmin && ctx.staff?.id !== shift.staff_id ? '代理入力' : null
    await writeActual(supabase, shift, { start, end }, { method: 'manual', actorId: ctx.user.id, note })
    return json({ ok: true })
  } catch (err) {
    console.error('works actuals 失敗:', err)
    return json({ error: '処理に失敗しました' }, 500)
  }
}

export async function handleActualsPlan(req) {
  const { ctx, error } = await requireWorks(req)
  if (error) return error
  const supabase = getAdminClient()
  try {
    const b = await req.json().catch(() => ({}))
    let shifts
    if (b.shift_id) {
      if (!UUID_RE.test(String(b.shift_id))) return json({ error: '勤務が正しくありません' }, 400)
      const { data } = await supabase.from('works_shifts').select(SHIFT_COLS).eq('id', b.shift_id)
      shifts = data || []
    } else {
      if (!UUID_RE.test(String(b.staff_id || '')) || !MONTH_RE.test(String(b.month || ''))) return json({ error: 'スタッフか月が正しくありません' }, 400)
      const { from, to } = monthRange(b.month)
      const last = to < todayJst() ? to : todayJst() // 今日までの日だけ
      const { data, error: e } = await supabase
        .from('works_shifts')
        .select(SHIFT_COLS)
        .eq('staff_id', b.staff_id)
        .gte('work_date', from)
        .lte('work_date', last)
        .order('work_date')
      if (e) throw e
      shifts = (data || []).filter((s) => !s.actual_start || !s.actual_end)
    }
    if (!shifts.length) return json({ count: 0 })
    if (!(await canInput(supabase, ctx, shifts[0].staff_id))) return json({ error: 'この勤務の時刻は入力できません' }, 403)
    if (!ctx.isAdmin && shifts.some((s) => s.work_date > todayJst())) return json({ error: '先の日の実績は入力できません' }, 400)
    let count = 0
    for (const s of shifts) {
      // 入っている方はそのまま、空いている方だけ予定の時刻を入れる（1 件指定のときは両方を予定どおりにする）
      const start = b.shift_id || !s.actual_start ? hm(s.plan_start) : undefined
      const end = b.shift_id || !s.actual_end ? hm(s.plan_end) : undefined
      if (await writeActual(supabase, s, { start, end }, { method: 'manual', actorId: ctx.user.id, note: '予定通り' })) count++
    }
    if (!b.shift_id) {
      const { data: st } = await supabase.from('works_staff').select('code').eq('id', shifts[0].staff_id).maybeSingle()
      await log(supabase, ctx, `実績を予定通りに一括入力: ${st?.code || ''} ${b.month}（${count} 日）`)
    }
    return json({ count })
  } catch (err) {
    console.error('works actuals plan 失敗:', err)
    return json({ error: '処理に失敗しました' }, 500)
  }
}

// 日報（タスク管理）の作業者・作業時間を、その担当のスタッフのその日の勤務に写す。
//   午前・午後の担当が同じなら出勤・退勤とも、違えば午前の担当に出勤・午後の担当に退勤を入れる。
//   入力方法が self / proxy のスタッフだけ（QR の人は打刻が正）。テレワークの日は写さない（本人が入力）。
//   時刻は打刻と同じきまり（30 分単位に丸め、予定の範囲にそろえる。6-5）。失敗しても日報の保存は止めない
export async function syncFromReport(report) {
  try {
    if (!report?.report_date) return
    const names = [report.worker_am, report.worker_pm].map((n) => (n || '').trim())
    if (!names[0] && !names[1]) return
    const supabase = getAdminClient()
    const { data: staff } = await supabase
      .from('works_staff')
      .select('id, report_name, punch_method')
      .in('report_name', [...new Set(names.filter(Boolean))])
      .in('punch_method', ['self', 'proxy'])
    if (!staff?.length) return
    const { data: settings } = await supabase.from('works_settings').select('rounding_minutes').eq('id', 1).maybeSingle()
    const unit = Number(settings?.rounding_minutes) || 30
    for (const st of staff) {
      const doStart = names[0] === st.report_name && report.work_start
      const doEnd = names[1] === st.report_name && report.work_end
      if (!doStart && !doEnd) continue
      const { data: shifts } = await supabase
        .from('works_shifts')
        .select(SHIFT_COLS)
        .eq('staff_id', st.id)
        .eq('work_date', report.report_date)
        .order('plan_start')
      const work = (shifts || []).filter((s) => !s.telework)
      if (!work.length) continue
      const first = work[0]
      const lastShift = work[work.length - 1]
      if (first.id === lastShift.id) {
        await writeActual(
          supabase,
          first,
          {
            start: doStart ? adoptedTime('in', hm(report.work_start), first, unit) : undefined,
            end: doEnd ? adoptedTime('out', hm(report.work_end), first, unit) : undefined,
          },
          { method: 'report', note: '日報から' }
        )
      } else {
        if (doStart) await writeActual(supabase, first, { start: adoptedTime('in', hm(report.work_start), first, unit) }, { method: 'report', note: '日報から' })
        if (doEnd) await writeActual(supabase, lastShift, { end: adoptedTime('out', hm(report.work_end), lastShift, unit) }, { method: 'report', note: '日報から' })
      }
    }
  } catch (err) {
    console.error('works 日報からの反映に失敗:', err)
  }
}
