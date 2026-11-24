// 勤怠管理（eWorks）Phase 4: 要確認（予定と実績の相違）の判定・一覧・通知（docs/eworks-plan.md 8章・13-1）
//
//   GET  /api/works/alerts?from&to&staff_id&status=open|resolved|all … 要確認の一覧（本人は自分の分だけ）
//   GET  /api/works/alerts/count                                     … 未確認の件数と承認待ちの修正申請の件数（管理者）
//   POST /api/works/alerts/resolve { keys, note, undo }              … 確認済みにする／確認済みを取り消す（管理者）
//
// 判定は予定（works_shifts）・打刻（works_punches）・休暇（works_leaves）から毎回計算する（8-3。画面ごとに判定を書かない）。
// 保存するのは「確認済み」「通知済み」の印だけ（works_alert_states）。
// 未出勤・退勤漏れは、入力方法が QR でアプリに登録済み（ログインできる）のスタッフだけを対象にする
// （入力方法が「本人」「管理者」のスタッフは外す。2026-11-24 依頼元の決定）。
// 位置の不一致は、現場の緯度・経度を登録した現場だけで判定する（未登録なら要確認にしない。2026-11-24 決定）。
import { json } from '../http.js'
import { getAdminClient } from '../supabase-admin.js'
import { requireWorks } from './auth.js'
import { addMonths, jstParts, todayJst, toMin } from './time.js'
import { sendWorksPush } from './push.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export const DEFAULT_RULES = { absent_min: 10, late_min: 5, early_min: 5, no_out_min: 60, overtime_min: 30 }

export const ALERT_KINDS = {
  absent: { label: '未出勤', level: 'high' },
  late: { label: '遅刻', level: 'mid' },
  early: { label: '早退', level: 'mid' },
  no_out: { label: '退勤漏れ', level: 'mid' },
  overtime: { label: '超過', level: 'mid' },
  no_plan: { label: '予定外の出勤', level: 'mid' },
  site_mismatch: { label: '現場違い', level: 'mid' },
  location: { label: '位置の不一致', level: 'low' },
  leave_punch: { label: '休暇日の打刻', level: 'mid' },
  corrected: { label: '訂正あり', level: 'low' },
}

export function rulesOf(settings) {
  const r = { ...DEFAULT_RULES }
  for (const k of Object.keys(DEFAULT_RULES)) {
    const v = Number(settings?.alert_rules?.[k])
    if (Number.isFinite(v) && v >= 0) r[k] = v
  }
  return r
}

const hm = (t) => (t ? String(t).slice(0, 5) : null)
const order = (p) => p.received_at || p.created_at || p.punched_at

// 勤務 1 件の「実際の時刻」（丸める前）。その勤務に結びついた打刻のうち、最後に記録したもの（二重の読み取りは除く）
function rawTimes(shift, punches) {
  const mine = punches.filter((p) => p.shift_id === shift.id && !(p.flags || []).includes('duplicate')).sort((a, b) => (order(a) < order(b) ? -1 : 1))
  const pick = (kind, actual) => {
    if (!actual) return null
    const list = mine.filter((p) => p.kind === kind && p.adopted)
    const last = list[list.length - 1]
    return last ? jstParts(new Date(last.punched_at)).time : hm(actual)
  }
  return { in: pick('in', shift.actual_start), out: pick('out', shift.actual_end) }
}

// 判定（DB に触らない。テストしやすいよう分けている）
//   staff: Map(id → { id, code, name, punch_method, user_id, status })
//   sites: Map(id → { id, lat, lng })
//   leaves: [{ staff_id, leave_date, kind }]
//   now: Date（今日の未出勤・退勤漏れの判定に使う）
export function detectAlerts({ shifts, punches, leaves, staff, sites, settings, now = new Date(), from = null }) {
  const rules = rulesOf(settings)
  const today = todayJst(now)
  const nowMin = toMin(jstParts(now).time)
  const startFrom = settings?.alerts_from || null
  const leaveSet = new Set(leaves.map((l) => `${l.staff_id}:${l.leave_date}`))
  const out = []
  const add = (kind, s, staffId, date, shiftId, detail, extra = {}) => {
    if (startFrom && date < startFrom) return
    if (from && date < from) return
    out.push({
      key: `${staffId}:${date}:${shiftId || '-'}:${kind}`,
      kind,
      label: ALERT_KINDS[kind].label,
      level: ALERT_KINDS[kind].level,
      staff_id: staffId,
      work_date: date,
      shift_id: shiftId || null,
      plan: s ? `${hm(s.plan_start)}〜${hm(s.plan_end)}` : null,
      site_id: s?.site_id || extra.site_id || null,
      detail,
      notify: extra.notify || null,
    })
  }

  // 勤務（予定）ごとの判定
  for (const s of shifts) {
    const st = staff.get(s.staff_id)
    if (!st) continue
    const date = s.work_date
    if (date > today) continue
    const onLeave = leaveSet.has(`${s.staff_id}:${date}`)
    // 未出勤・退勤漏れを見る人: 入力方法が QR で、アプリに登録済み（ログインできる）
    const watched = (st.punch_method || 'qr') === 'qr' && !!st.user_id && st.status !== 'retired'
    const ps = toMin(s.plan_start)
    const pe = toMin(s.plan_end)
    const past = date < today
    if (!s.actual_start) {
      if (watched && !onLeave && (past || nowMin > ps + rules.absent_min)) {
        add('absent', s, s.staff_id, date, s.id, `${hm(s.plan_start)} の出勤予定に出勤の記録がありません`, { notify: 'admin' })
      }
      continue
    }
    if (!s.actual_end && watched && (past || nowMin > pe + rules.no_out_min)) {
      add('no_out', s, s.staff_id, date, s.id, `${hm(s.plan_end)} の退勤予定を過ぎても退勤の記録がありません`, { notify: 'staff' })
    }
    const t = rawTimes(s, punches)
    if (t.in && toMin(t.in) > ps + rules.late_min) add('late', s, s.staff_id, date, s.id, `出勤 ${t.in}（予定 ${hm(s.plan_start)}）`)
    if (t.out && toMin(t.out) < pe - rules.early_min) add('early', s, s.staff_id, date, s.id, `退勤 ${t.out}（予定 ${hm(s.plan_end)}）`)
    if (t.out && toMin(t.out) > pe + rules.overtime_min) add('overtime', s, s.staff_id, date, s.id, `退勤 ${t.out}（予定 ${hm(s.plan_end)}）`)
  }

  // 打刻の印からの判定
  const byShift = new Map()
  const noPlanDays = new Map()
  const leavePunchDays = new Map()
  for (const p of punches) {
    const st = staff.get(p.staff_id)
    if (!st) continue
    const flags = p.flags || []
    const time = jstParts(new Date(p.punched_at)).time
    const kindLabel = p.kind === 'in' ? '出勤' : '退勤'
    if (flags.includes('no_plan')) {
      const k = `${p.staff_id}:${p.work_date}`
      if (!noPlanDays.has(k)) noPlanDays.set(k, { p, times: [] })
      noPlanDays.get(k).times.push(`${kindLabel} ${time}`)
    }
    if (leaveSet.has(`${p.staff_id}:${p.work_date}`) && !['manual', 'report'].includes(p.method)) {
      const k = `${p.staff_id}:${p.work_date}`
      if (!leavePunchDays.has(k)) leavePunchDays.set(k, { p, times: [] })
      leavePunchDays.get(k).times.push(`${kindLabel} ${time}`)
    }
    if (!p.shift_id) continue
    const g = byShift.get(p.shift_id) || { site: [], loc: [], corr: [], p }
    byShift.set(p.shift_id, g)
    if (flags.includes('site_mismatch')) g.site.push(`${kindLabel} ${time}`)
    const site = p.site_id ? sites.get(p.site_id) : null
    const siteHasPos = site && site.lat != null && site.lng != null
    if (siteHasPos && flags.includes('far')) g.loc.push(`${kindLabel} ${time} 現場から ${p.distance_m ?? '?'}m`)
    else if (siteHasPos && flags.includes('no_location')) g.loc.push(`${kindLabel} ${time} 位置情報なし`)
    // 訂正あり: その人のふだんの入力方法ではない方法で時刻が入った（修正申請の承認・管理者の代理入力や訂正）
    const method = st.punch_method || 'qr'
    if (p.method === 'correction') g.corr.push(`${kindLabel} 修正申請を承認`)
    else if (method !== 'proxy' && p.method === 'proxy') g.corr.push(`${kindLabel} 管理者が代理入力`)
    else if (method !== 'proxy' && p.method === 'manual' && p.created_by && p.created_by !== st.user_id) g.corr.push(`${kindLabel} 管理者が訂正`)
  }
  const shiftById = new Map(shifts.map((s) => [s.id, s]))
  for (const [sid, g] of byShift) {
    const s = shiftById.get(sid) || null
    const { staff_id: staffId, work_date: date } = g.p
    if (g.site.length) add('site_mismatch', s, staffId, date, sid, `予定と違う現場の QR（${g.site.join('、')}）`, { site_id: g.p.site_id })
    if (g.loc.length) add('location', s, staffId, date, sid, g.loc.join('、'), { site_id: g.p.site_id })
    if (g.corr.length) add('corrected', s, staffId, date, sid, [...new Set(g.corr)].join('、'))
  }
  for (const { p, times } of noPlanDays.values()) add('no_plan', null, p.staff_id, p.work_date, null, `予定のない打刻（${times.join('、')}）`, { site_id: p.site_id })
  for (const { p, times } of leavePunchDays.values()) add('leave_punch', null, p.staff_id, p.work_date, null, `休暇の日に打刻（${times.join('、')}）`)

  return out.sort((a, b) => (a.work_date === b.work_date ? (a.level === b.level ? 0 : a.level === 'high' ? -1 : 1) : a.work_date < b.work_date ? 1 : -1))
}

// Supabase は 1 回に 1000 行までしか返さないので、分けて読む
async function selectAll(build) {
  const rows = []
  for (let i = 0; ; i += 1000) {
    const { data, error } = await build().range(i, i + 999)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < 1000) return rows
  }
}

// 期間の要確認を判定し、確認済みの印を付けて返す
export async function loadAlerts(supabase, { from, to, staffId = null, now = new Date() }) {
  const { data: settings } = await supabase.from('works_settings').select('alert_rules, alerts_from').eq('id', 1).maybeSingle()
  const byStaff = (q) => (staffId ? q.eq('staff_id', staffId) : q)
  const [shifts, punches, leaves, { data: staffRows }, { data: siteRows }, states] = await Promise.all([
    selectAll(() => byStaff(supabase.from('works_shifts').select('id, staff_id, work_date, site_id, plan_start, plan_end, actual_start, actual_end, telework').gte('work_date', from).lte('work_date', to).order('id'))),
    selectAll(() => byStaff(supabase.from('works_punches').select('id, staff_id, work_date, kind, punched_at, received_at, method, site_id, shift_id, adopted, flags, distance_m, created_by').gte('work_date', from).lte('work_date', to).order('id'))),
    selectAll(() => byStaff(supabase.from('works_leaves').select('staff_id, leave_date, kind').gte('leave_date', from).lte('leave_date', to).order('id'))),
    supabase.from('works_staff').select('id, code, name, punch_method, user_id, status'),
    supabase.from('works_sites').select('id, code, name, lat, lng'),
    selectAll(() => byStaff(supabase.from('works_alert_states').select('*').gte('work_date', from).lte('work_date', to).order('alert_key'))),
  ])
  const staff = new Map((staffRows || []).map((s) => [s.id, s]))
  const sites = new Map((siteRows || []).map((s) => [s.id, s]))
  const stateMap = new Map(states.map((s) => [s.alert_key, s]))
  const items = detectAlerts({ shifts, punches, leaves, staff, sites, settings: settings || {}, now }).map((a) => {
    const st = staff.get(a.staff_id)
    const state = stateMap.get(a.key)
    return {
      ...a,
      staff: st ? { id: st.id, code: st.code, name: st.name } : null,
      site: a.site_id && sites.get(a.site_id) ? { code: sites.get(a.site_id).code, name: sites.get(a.site_id).name } : null,
      resolved_at: state?.resolved_at || null,
      resolved_by: state?.resolved_by || null,
      note: state?.note || null,
      notified_at: state?.notified_at || null,
    }
  })
  return { items, settings: settings || {} }
}

// 件数を数える期間: 前の月の 1 日（または要確認を出し始める日）から今日まで
async function countRange(supabase) {
  const today = todayJst()
  let from = `${addMonths(today.slice(0, 7), -1)}-01`
  const { data } = await supabase.from('works_settings').select('alerts_from').eq('id', 1).maybeSingle()
  if (data?.alerts_from && data.alerts_from > from) from = data.alerts_from
  return { from, to: today }
}

export async function handleAlerts(req) {
  const { ctx, error } = await requireWorks(req)
  if (error) return error
  const url = new URL(req.url)
  const supabase = getAdminClient()
  let { from, to } = Object.fromEntries(['from', 'to'].map((k) => [k, url.searchParams.get(k)]))
  if (!from || !to) ({ from, to } = await countRange(supabase))
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) return json({ error: '期間が正しくありません' }, 400)
  const today = todayJst()
  if (to > today) to = today
  if (from > to) return json({ items: [] })
  let staffId = url.searchParams.get('staff_id') || null
  if (!ctx.isAdmin) {
    if (!ctx.staff) return json({ error: 'スタッフ情報が紐づいていません' }, 403)
    staffId = ctx.staff.id
  } else if (staffId && !UUID_RE.test(staffId)) return json({ error: 'スタッフが正しくありません' }, 400)
  const { items } = await loadAlerts(supabase, { from, to, staffId })
  const status = url.searchParams.get('status') || 'open'
  const list = items.filter((a) => (status === 'all' ? true : status === 'resolved' ? !!a.resolved_at : !a.resolved_at))
  return json({
    from,
    to,
    items: ctx.isAdmin ? list : list.map(({ notified_at: _n, resolved_by: _b, ...rest }) => rest),
  })
}

export async function handleAlertCount(req) {
  const { error } = await requireWorks(req, { admin: true })
  if (error) return error
  const supabase = getAdminClient()
  const range = await countRange(supabase)
  const [{ items }, { count }] = await Promise.all([
    range.from <= range.to ? loadAlerts(supabase, range) : { items: [] },
    supabase.from('works_punch_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
  ])
  const open = items.filter((a) => !a.resolved_at)
  return json({ ...range, open: open.length, high: open.filter((a) => a.level === 'high').length, requests: count || 0 })
}

export async function handleAlertResolve(req) {
  const { ctx, error } = await requireWorks(req, { admin: true })
  if (error) return error
  const b = await req.json().catch(() => ({}))
  const keys = Array.isArray(b.keys) ? b.keys.filter((k) => typeof k === 'string' && /^[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}:[0-9a-f-]{1,36}:[a-z_]+$/i.test(k)) : []
  if (!keys.length || keys.length > 500) return json({ error: '要確認が選ばれていません' }, 400)
  const supabase = getAdminClient()
  const now = new Date().toISOString()
  const { data: cur, error: e0 } = await supabase.from('works_alert_states').select('alert_key, notified_at').in('alert_key', keys)
  if (e0) throw e0
  const curMap = new Map((cur || []).map((c) => [c.alert_key, c]))
  const rows = keys.map((k) => {
    const [staffId, date, , kind] = k.split(':')
    return {
      alert_key: k,
      staff_id: staffId,
      work_date: date,
      kind,
      notified_at: curMap.get(k)?.notified_at || null,
      resolved_at: b.undo ? null : now,
      resolved_by: b.undo ? null : ctx.user.id,
      note: b.undo ? null : b.note ? String(b.note).slice(0, 200) : null,
      updated_at: now,
    }
  })
  const { error: e } = await supabase.from('works_alert_states').upsert(rows, { onConflict: 'alert_key' })
  if (e) throw e
  return json({ ok: true, count: rows.length })
}

// ---------------------------------------------------------------------------
// 定期実行（5 分おき）: 未出勤を管理者へ、退勤漏れを本人へプッシュ通知する（13-1 の 1・2）。
// 同じ件は 1 回だけ送る（works_alert_states.notified_at）。確認済みの件は送らない
// ---------------------------------------------------------------------------
export async function runAlertNotifications(now = new Date()) {
  const supabase = getAdminClient()
  const today = todayJst(now)
  const yesterday = todayJst(new Date(now.getTime() - 24 * 3600e3))
  const { items } = await loadAlerts(supabase, { from: yesterday, to: today, now })
  const due = items.filter((a) => a.notify && !a.resolved_at && !a.notified_at)
  if (!due.length) return { sent: 0 }
  const stamp = now.toISOString()
  // 先に印を付ける（送信の失敗で何度も送らないように）
  const { error } = await supabase.from('works_alert_states').upsert(
    due.map((a) => ({ alert_key: a.key, staff_id: a.staff_id, work_date: a.work_date, kind: a.kind, notified_at: stamp, updated_at: stamp })),
    { onConflict: 'alert_key' }
  )
  if (error) throw error

  const absent = due.filter((a) => a.notify === 'admin')
  if (absent.length) {
    const { data: admins } = await supabase.from('users').select('id').eq('works_admin', true)
    const names = absent.map((a) => `${a.staff?.name || ''}（${a.plan?.slice(0, 5) || ''}${a.site ? ` ${a.site.name}` : ''}）`)
    await sendWorksPush(supabase, (admins || []).map((u) => u.id), {
      title: `未出勤 ${absent.length} 名`,
      body: `${names.slice(0, 3).join('、')}${names.length > 3 ? ` ほか ${names.length - 3} 名` : ''} の出勤の記録がありません`,
      url: '/alerts',
    })
  }
  const noOut = due.filter((a) => a.notify === 'staff')
  if (noOut.length) {
    const { data: staffRows } = await supabase.from('works_staff').select('id, user_id').in('id', [...new Set(noOut.map((a) => a.staff_id))])
    const userOf = new Map((staffRows || []).map((s) => [s.id, s.user_id]))
    for (const a of noOut) {
      const uid = userOf.get(a.staff_id)
      if (!uid) continue
      await sendWorksPush(supabase, [uid], {
        title: '退勤の記録がありません',
        body: `${Number(a.work_date.slice(5, 7))}月${Number(a.work_date.slice(8))}日 ${a.plan || ''} の退勤を記録してください。記録を忘れた場合はカレンダーから修正を申請できます`,
        url: '/',
      })
    }
  }
  return { sent: due.length }
}
