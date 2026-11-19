// 有給休暇・特別休暇（docs/eworks-spec-leave.md。現行 FileMaker の数え方を踏襲）
//
//   付与期間: 入社月の 6 か月後の月の 1 日から 1 年ごと。付与日数は期間開始時の継続勤務月数で決める（全員同じ表）
//   繰越分から先に消化し、使い切れなかった繰越分は期間末に消える（2 年で時効）
//   2018/01/01 より前に始まる期間の繰越は 0（取得の記録がそれ以前にないため。FileMaker と同じ）
//   特別休暇: 有休の付与がある期間に 5 日。特別休暇を取った日は有休も 1 日として数える（決定 10）
import { json } from '../http.js'
import { getAdminClient } from '../supabase-admin.js'
import { requireWorks } from './auth.js'
import { log } from './masters.js'
import { fetchHolidays } from '../holidays.js'
import { todayJst } from './time.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GRANT_TABLE = [[78, 20], [66, 18], [54, 16], [42, 14], [30, 12], [18, 11], [6, 10]]
export const SPECIAL_DAYS = 5
export const FIVE_DAY_RULE = 5 // 年 5 日の取得義務（付与 10 日以上の人）
const NO_CARRY_BEFORE = '2018-01-01'

export function grantDays(months) {
  for (const [m, g] of GRANT_TABLE) if (months >= m) return g
  return 0
}

const ymd = (y, m, d = 1) => {
  const yy = y + Math.floor((m - 1) / 12)
  const mm = ((m - 1) % 12 + 12) % 12 + 1
  return `${yy}-${String(mm).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
function dayBefore(date) {
  const t = new Date(`${date}T00:00:00Z`)
  t.setUTCDate(t.getUTCDate() - 1)
  return t.toISOString().slice(0, 10)
}

// 入社日から、at を含む期間までの全期間を計算する。paid / special は取得日（YYYY-MM-DD）の配列
export function leavePeriods(hiredOn, paid, special, at) {
  if (!hiredOn || !DATE_RE.test(hiredOn)) return []
  const hy = Number(hiredOn.slice(0, 4))
  const hm = Number(hiredOn.slice(5, 7))
  const paidDays = [...new Set(paid)].sort()
  const specialDays = [...new Set(special)].sort()
  const out = []
  let carry = 0
  for (let k = 0; ; k++) {
    const start = ymd(hy, hm + 6 + 12 * k)
    if (start > at) break
    const end = dayBefore(ymd(hy, hm + 18 + 12 * k))
    const months = 6 + 12 * k
    const grant = grantDays(months)
    if (start < NO_CARRY_BEFORE) carry = 0
    const takenDays = paidDays.filter((d) => d >= start && d <= end)
    const taken = takenDays.length
    const fromCarry = Math.min(taken, carry)
    const fromGrant = taken - fromCarry
    const sp = specialDays.filter((d) => d >= start && d <= end)
    const specialGrant = grant > 0 ? SPECIAL_DAYS : 0
    out.push({
      start,
      end,
      months,
      carry,
      grant,
      taken,
      from_carry: fromCarry,
      from_grant: fromGrant,
      remain: carry + grant - taken,
      expire: carry - fromCarry,
      special_grant: specialGrant,
      special_taken: sp.length,
      special_remain: specialGrant - sp.length,
      paid_days: takenDays,
      special_days: sp,
    })
    carry = Math.max(grant - fromGrant, 0)
  }
  return out
}

// 一覧の 1 行（at の日を含む期間。まだ最初の付与前なら period は null）
export function leaveSummary(staff, paid, special, at) {
  const periods = leavePeriods(staff.hired_on, paid, special, at)
  const cur = periods[periods.length - 1] || null
  const month = at.slice(0, 7)
  const firstGrant = staff.hired_on ? ymd(Number(staff.hired_on.slice(0, 4)), Number(staff.hired_on.slice(5, 7)) + 6) : null
  return {
    staff_id: staff.id,
    code: staff.code,
    name: staff.name,
    status: staff.status,
    hired_on: staff.hired_on,
    first_grant: firstGrant,
    period: cur && {
      start: cur.start,
      end: cur.end,
      carry: cur.carry,
      grant: cur.grant,
      taken: cur.taken,
      from_carry: cur.from_carry,
      from_grant: cur.from_grant,
      remain: cur.remain,
      expire: cur.expire,
      special_grant: cur.special_grant,
      special_taken: cur.special_taken,
      special_remain: cur.special_remain,
      // 年 5 日: 付与 10 日以上の期間で、期間内に 5 日以上取れているか
      five_day_short: cur.grant >= 10 ? Math.max(FIVE_DAY_RULE - cur.taken, 0) : null,
    },
    month_paid: [...new Set(paid)].filter((d) => d.startsWith(month)).length,
    month_special: [...new Set(special)].filter((d) => d.startsWith(month)).length,
  }
}

async function loadLeaves(supabase, staffId = null) {
  const all = []
  for (let from = 0; ; from += 1000) {
    let q = supabase.from('works_leaves').select('id, staff_id, leave_date, kind, source, note').order('leave_date').range(from, from + 999)
    if (staffId) q = q.eq('staff_id', staffId)
    const { data, error } = await q
    if (error) throw error
    all.push(...data)
    if (data.length < 1000) break
  }
  return all
}

function split(rows) {
  const by = {}
  for (const r of rows) {
    const x = (by[r.staff_id] ||= { paid: [], special: [] })
    x[r.kind === 'special' ? 'special' : 'paid'].push(r.leave_date)
  }
  return by
}

// GET /api/works/leave?at=YYYY-MM-DD            … 全スタッフの今の期間（管理者）
// GET /api/works/leave?staff_id=…&at=…          … 1 人の全期間と取得日（管理者）
// POST /api/works/leave {staff_id, date, kind, note} … 取得日を登録（特別休暇は同じ日の有休も登録）
// DELETE /api/works/leave?id=…                  … 取得日を取り消す（特別休暇は同じ日の有休も取り消す）
export async function handleLeave(req) {
  const { ctx, error } = await requireWorks(req, { admin: true })
  if (error) return error
  const supabase = getAdminClient()
  const url = new URL(req.url)
  try {
    if (req.method === 'GET') {
      const at = DATE_RE.test(url.searchParams.get('at') || '') ? url.searchParams.get('at') : todayJst()
      const staffId = url.searchParams.get('staff_id')
      if (staffId) {
        if (!UUID_RE.test(staffId)) return json({ error: 'スタッフが正しくありません' }, 400)
        const [{ data: staff }, rows] = await Promise.all([
          supabase.from('works_staff').select('id, code, name, status, hired_on').eq('id', staffId).maybeSingle(),
          loadLeaves(supabase, staffId),
        ])
        if (!staff) return json({ error: 'スタッフが見つかりません' }, 404)
        const { paid = [], special = [] } = split(rows)[staffId] || {}
        const periods = leavePeriods(staff.hired_on, paid, special, at).reverse()
        return json({ at, staff, summary: leaveSummary(staff, paid, special, at), periods, items: rows })
      }
      const [{ data: staff, error: e }, rows] = await Promise.all([
        supabase.from('works_staff').select('id, code, name, status, hired_on').neq('status', 'retired').order('code'),
        loadLeaves(supabase),
      ])
      if (e) throw e
      const by = split(rows)
      return json({ at, items: staff.map((s) => leaveSummary(s, by[s.id]?.paid || [], by[s.id]?.special || [], at)) })
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      if (!UUID_RE.test(String(body.staff_id || ''))) return json({ error: 'スタッフが正しくありません' }, 400)
      if (!DATE_RE.test(String(body.date || ''))) return json({ error: '日付が正しくありません' }, 400)
      const kind = body.kind === 'special' ? 'special' : 'paid'
      if (kind === 'special') {
        const holidays = await fetchHolidays().catch(() => null)
        if (holidays && !holidays[body.date]) return json({ error: '特別休暇は祝日・振替休日だけ指定できます' }, 400)
      }
      const note = String(body.note || '').trim().slice(0, 200) || null
      const rows = [{ staff_id: body.staff_id, leave_date: body.date, kind, source: 'manual', note, created_by: ctx.user.id }]
      if (kind === 'special') rows.push({ ...rows[0], kind: 'paid' })
      const { error: e } = await supabase.from('works_leaves').upsert(rows, { onConflict: 'staff_id,leave_date,kind', ignoreDuplicates: true })
      if (e) throw e
      const { data: s } = await supabase.from('works_staff').select('code, name').eq('id', body.staff_id).maybeSingle()
      await log(supabase, ctx, `${kind === 'special' ? '特別休暇' : '有給休暇'}を登録: ${s?.code || ''} ${body.date}`)
      return json({ ok: true })
    }

    if (req.method === 'DELETE') {
      const id = url.searchParams.get('id')
      if (!UUID_RE.test(String(id || ''))) return json({ error: 'id が正しくありません' }, 400)
      const { data: row } = await supabase.from('works_leaves').select('*').eq('id', id).maybeSingle()
      if (!row) return json({ error: '見つかりません' }, 404)
      let q = supabase.from('works_leaves').delete().eq('staff_id', row.staff_id).eq('leave_date', row.leave_date)
      if (row.kind === 'paid') q = q.eq('kind', 'paid')
      const { error: e } = await q
      if (e) throw e
      const { data: s } = await supabase.from('works_staff').select('code').eq('id', row.staff_id).maybeSingle()
      await log(supabase, ctx, `${row.kind === 'special' ? '特別休暇' : '有給休暇'}を取り消し: ${s?.code || ''} ${row.leave_date}`)
      return json({ ok: true })
    }
    return json({ error: 'Method Not Allowed' }, 405)
  } catch (err) {
    console.error('works leave 失敗:', err)
    return json({ error: '処理に失敗しました' }, 500)
  }
}
