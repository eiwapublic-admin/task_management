// 打刻の修正申請（docs/eworks-plan.md 6-3・13-1 の 3。2026-11-24）
//
//   GET  /api/works/punch-requests?status=pending|all&staff_id   … 申請の一覧（本人は自分の分だけ）
//   POST /api/works/punch-requests { shift_id, start, end, reason } … 本人が申請（今日までの自分の勤務）
//   POST /api/works/punch-requests/decide { id, action: approve|reject|cancel, note }
//        … 管理者が承認・却下（承認すると勤務の時刻に反映し、打刻の記録に method=correction で残す）。本人は承認待ちを取り下げできる
//
// 承認した時刻は申請どおりに入れる（丸めない。管理者が確かめた時刻のため）。
import { json } from '../http.js'
import { getAdminClient } from '../supabase-admin.js'
import { requireWorks } from './auth.js'
import { writeActual } from './actuals.js'
import { log } from './masters.js'
import { pushToAdmins, pushToStaff } from './push.js'
import { todayJst } from './time.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const hm = (t) => (t ? String(t).slice(0, 5) : null)
const dayLabel = (d) => `${Number(d.slice(5, 7))}月${Number(d.slice(8))}日`

export async function handlePunchRequests(req) {
  const { ctx, error } = await requireWorks(req)
  if (error) return error
  const supabase = getAdminClient()
  if (req.method === 'GET') {
    const url = new URL(req.url)
    const status = url.searchParams.get('status') || 'pending'
    let q = supabase
      .from('works_punch_requests')
      .select('id, staff_id, shift_id, work_date, start_time, end_time, reason, status, applied_at, decided_at, decision_note')
      .order('applied_at', { ascending: false })
      .limit(200)
    if (status !== 'all') q = q.eq('status', status)
    let staffId = url.searchParams.get('staff_id')
    if (!ctx.isAdmin) {
      if (!ctx.staff) return json({ items: [] })
      staffId = ctx.staff.id
    }
    if (staffId) {
      if (!UUID_RE.test(staffId)) return json({ error: 'スタッフが正しくありません' }, 400)
      q = q.eq('staff_id', staffId)
    }
    const { data, error: e } = await q
    if (e) throw e
    const shiftIds = [...new Set((data || []).map((r) => r.shift_id).filter(Boolean))]
    const staffIds = [...new Set((data || []).map((r) => r.staff_id))]
    const [{ data: shifts }, { data: staff }] = await Promise.all([
      shiftIds.length ? supabase.from('works_shifts').select('id, plan_start, plan_end, actual_start, actual_end').in('id', shiftIds) : { data: [] },
      staffIds.length ? supabase.from('works_staff').select('id, code, name').in('id', staffIds) : { data: [] },
    ])
    const sm = new Map((shifts || []).map((s) => [s.id, s]))
    const stm = new Map((staff || []).map((s) => [s.id, s]))
    return json({
      items: (data || []).map((r) => {
        const s = sm.get(r.shift_id)
        return {
          ...r,
          start_time: hm(r.start_time),
          end_time: hm(r.end_time),
          staff: stm.get(r.staff_id) || null,
          shift: s ? { plan_start: hm(s.plan_start), plan_end: hm(s.plan_end), actual_start: hm(s.actual_start), actual_end: hm(s.actual_end) } : null,
        }
      }),
    })
  }
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405)
  if (!ctx.staff) return json({ error: 'スタッフ情報が紐づいていません' }, 403)
  const b = await req.json().catch(() => ({}))
  if (!UUID_RE.test(String(b.shift_id || ''))) return json({ error: '勤務が正しくありません' }, 400)
  const start = b.start ? String(b.start) : null
  const end = b.end ? String(b.end) : null
  if (!start && !end) return json({ error: '直したい出勤か退勤の時刻を入力してください' }, 400)
  for (const t of [start, end]) if (t && !TIME_RE.test(t)) return json({ error: '時刻は 09:00 のように入力してください' }, 400)
  const reason = String(b.reason || '').trim().slice(0, 200)
  if (!reason) return json({ error: '理由を入力してください（打刻を忘れた、など）' }, 400)
  const { data: shift } = await supabase.from('works_shifts').select('id, staff_id, work_date, actual_start, actual_end').eq('id', b.shift_id).maybeSingle()
  if (!shift || shift.staff_id !== ctx.staff.id) return json({ error: '勤務が見つかりません' }, 404)
  if (shift.work_date > todayJst()) return json({ error: '先の日の修正は申請できません' }, 400)
  const s = start || hm(shift.actual_start)
  const e2 = end || hm(shift.actual_end)
  if (s && e2 && e2 <= s) return json({ error: '退勤は出勤より後の時刻にしてください' }, 400)
  const { data: dup } = await supabase.from('works_punch_requests').select('id').eq('shift_id', shift.id).eq('status', 'pending').limit(1)
  if (dup?.length) return json({ error: 'この日の修正申請はすでに承認待ちです（取り下げてから申請し直せます）' }, 400)
  const { data, error: e } = await supabase
    .from('works_punch_requests')
    .insert({ staff_id: ctx.staff.id, shift_id: shift.id, work_date: shift.work_date, start_time: start, end_time: end, reason, applied_by: ctx.user.id })
    .select('id')
    .single()
  if (e) throw e
  await pushToAdmins(supabase, {
    title: '打刻の修正申請',
    body: `${ctx.staff.name} さん ${dayLabel(shift.work_date)}（${[start && `出勤 ${start}`, end && `退勤 ${end}`].filter(Boolean).join('・')}）${reason}`,
    url: '/alerts?tab=requests',
  })
  return json({ id: data.id })
}

export async function handlePunchRequestDecide(req) {
  const { ctx, error } = await requireWorks(req)
  if (error) return error
  const b = await req.json().catch(() => ({}))
  if (!UUID_RE.test(String(b.id || ''))) return json({ error: '申請が正しくありません' }, 400)
  if (!['approve', 'reject', 'cancel'].includes(b.action)) return json({ error: '操作が正しくありません' }, 400)
  const supabase = getAdminClient()
  const { data: r } = await supabase.from('works_punch_requests').select('*').eq('id', b.id).maybeSingle()
  if (!r) return json({ error: '申請が見つかりません' }, 404)
  if (r.status !== 'pending') return json({ error: 'この申請はすでに処理済みです' }, 400)
  const now = new Date().toISOString()
  if (b.action === 'cancel') {
    if (!ctx.staff || ctx.staff.id !== r.staff_id) return json({ error: '自分の申請だけ取り下げできます' }, 403)
    await supabase.from('works_punch_requests').update({ status: 'cancelled', updated_at: now }).eq('id', r.id)
    return json({ ok: true })
  }
  if (!ctx.isAdmin) return json({ error: 'この操作は eWorks 管理者だけができます' }, 403)
  const note = b.note ? String(b.note).slice(0, 200) : null
  if (b.action === 'approve') {
    const { data: shift } = await supabase.from('works_shifts').select('id, staff_id, work_date, site_id, plan_start, plan_end, actual_start, actual_end').eq('id', r.shift_id).maybeSingle()
    if (!shift) return json({ error: '申請した日の予定が削除されています。カレンダーから直接入力してください' }, 400)
    const start = r.start_time ? hm(r.start_time) : undefined
    const end = r.end_time ? hm(r.end_time) : undefined
    const s = start || hm(shift.actual_start)
    const e = end || hm(shift.actual_end)
    if (s && e && e <= s) return json({ error: '承認すると退勤が出勤より前になります。カレンダーから直接直してください' }, 400)
    await writeActual(supabase, shift, { start, end }, { method: 'correction', actorId: ctx.user.id, note: `修正申請: ${r.reason}` })
  }
  const status = b.action === 'approve' ? 'approved' : 'rejected'
  const { error: e } = await supabase
    .from('works_punch_requests')
    .update({ status, decided_by: ctx.user.id, decided_at: now, decision_note: note, updated_at: now })
    .eq('id', r.id)
  if (e) throw e
  const { data: st } = await supabase.from('works_staff').select('code').eq('id', r.staff_id).maybeSingle()
  await log(supabase, ctx, `打刻の修正申請を${status === 'approved' ? '承認' : '却下'}: ${st?.code || ''} ${r.work_date}`)
  await pushToStaff(supabase, r.staff_id, {
    title: status === 'approved' ? '修正申請が承認されました' : '修正申請が却下されました',
    body: `${dayLabel(r.work_date)} の打刻の修正${note ? `（${note}）` : ''}`,
    url: `/calendar?month=${r.work_date.slice(0, 7)}`,
  })
  return json({ ok: true })
}
