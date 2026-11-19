// 勤怠管理（eWorks）Phase 3: QR 打刻（docs/eworks-plan.md 6章）
//
//   POST /api/works/sites/qr        { id }                         … 現場の QR を発行・再発行（管理者。古い QR は無効になる）
//   GET  /api/works/punch/today                                    … 本人の今日の予定・打刻・状態
//   POST /api/works/punch           { c, k, t, lat, lng, accuracy, device_at, offline, confirm } … 本人の QR 打刻
//   POST /api/works/punch/proxy     { staff_id, work_date, kind, time, note } … 管理者の代理入力
//   GET  /api/works/punches?staff_id&date                          … その日の打刻の記録（本人は自分の分だけ）
//
// 時刻はサーバーの時刻を使う（端末の時計をずらしても影響しない）。電波がなく端末に一時保存した打刻だけは
// 端末の時刻を使い、「オフライン打刻」の印を付ける。打刻の記録は追記のみで、勤務区間（works_shifts）の
// 採用時刻（actual_start / actual_end）は 6-5 のきまりで決める。
import { json } from '../http.js'
import { getAdminClient } from '../supabase-admin.js'
import { requireWorks } from './auth.js'
import { adoptedTime, distanceM, jstParts, shiftMinutes, todayJst, toMin } from './time.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
// オフライン打刻として受け付ける端末時刻の範囲（古すぎる・未来すぎるものはサーバー時刻にする）
const OFFLINE_MAX_AGE_MS = 3 * 24 * 3600e3
const FUTURE_SLACK_MS = 5 * 60e3

export const FLAG_LABEL = {
  site_mismatch: '現場違い',
  no_plan: '予定外の出勤',
  far: '位置不一致',
  no_location: '位置情報なし',
  offline: 'オフライン打刻',
  duplicate: '二重の読み取り',
  no_in: '出勤の記録なし',
  proxy: '代理入力',
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// QR の合言葉。サーバーの秘密鍵（SESSION_SECRET）と「現場・発行日時」から HMAC で作る。
// DB には合言葉そのものは置かず（ハッシュだけ）、それでも同じ QR を印刷し直せるようにするため（2026-11-19 依頼元の要望）。
// 再発行すると発行日時が変わり、合言葉も変わる（古い QR は使えなくなる）
async function qrToken(siteId, issuedAt) {
  const secret = process.env.SESSION_SECRET
  if (!secret) throw new Error('SESSION_SECRET が設定されていません')
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const msg = `works-qr:${siteId}:${new Date(issuedAt).getTime()}`
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg))).slice(0, 24)
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const hm = (t) => (t ? String(t).slice(0, 5) : null)

// POST /api/works/sites/qr { id, mode: 'issue' | 'print' }
//   issue … 発行・再発行（古い QR は使えなくなる）／print … いまの QR を印刷し直す（QR は変わらない）
export async function handleSiteQr(req) {
  const { error } = await requireWorks(req, { admin: true })
  if (error) return error
  const b = await req.json().catch(() => ({}))
  if (!UUID_RE.test(String(b.id || ''))) return json({ error: '現場が正しくありません' }, 400)
  const supabase = getAdminClient()
  if (b.mode === 'print') {
    const { data: site } = await supabase
      .from('works_sites')
      .select('id, code, name, detail, qr_issued_at, qr_secret_hash')
      .eq('id', b.id)
      .maybeSingle()
    if (!site?.qr_secret_hash || !site.qr_issued_at) return json({ error: 'この現場はまだ QR を発行していません' }, 400)
    const token = await qrToken(site.id, site.qr_issued_at)
    if ((await sha256Hex(token)) !== site.qr_secret_hash) {
      return json({ error: '以前の方式で発行した QR のため印刷し直せません。お手数ですが一度だけ「再発行」してください' }, 400)
    }
    const { qr_secret_hash: _h, ...rest } = site
    return json({ site: rest, token, reprint: true })
  }
  const issuedAt = new Date().toISOString()
  const token = await qrToken(b.id, issuedAt)
  const { data, error: e } = await supabase
    .from('works_sites')
    .update({ qr_secret_hash: await sha256Hex(token), qr_issued_at: issuedAt })
    .eq('id', b.id)
    .select('id, code, name, detail, qr_issued_at')
    .single()
  if (e) throw e
  return json({ site: data, token, reprint: false })
}

async function loadSettings(supabase) {
  const { data } = await supabase.from('works_settings').select('*').eq('id', 1).maybeSingle()
  return data || {}
}

async function dayShifts(supabase, staffId, date) {
  const { data, error } = await supabase
    .from('works_shifts')
    .select('id, site_id, plan_start, plan_end, actual_start, actual_end, source')
    .eq('staff_id', staffId)
    .eq('work_date', date)
    .order('plan_start')
  if (error) throw error
  return data || []
}

// 打刻をどの勤務区間に結びつけるか。
//   出勤: まだ出勤していない区間（同じ現場を優先）。無ければ同じ現場の区間（＝二重の読み取り）
//   退勤: 出勤済みで退勤していない区間（同じ現場を優先）。無ければ同じ現場の区間・最初の区間
export function chooseShift(shifts, kind, siteId) {
  if (!shifts.length) return null
  const bySite = (list) => list.find((s) => s.site_id === siteId) || list[0] || null
  if (kind === 'in') {
    const open = shifts.filter((s) => !s.actual_start)
    return bySite(open.length ? open : shifts)
  }
  const working = shifts.filter((s) => s.actual_start && !s.actual_end)
  if (working.length) return bySite(working)
  const notDone = shifts.filter((s) => !s.actual_end)
  return bySite(notDone.length ? notDone : shifts)
}

// 打刻 1 件を記録する（QR・代理入力の共通部分）
export async function recordPunch(supabase, { staff, kind, at, method, site, lat, lng, accuracy, deviceAt, offline, confirm, note, actor }) {
  const { date, time } = jstParts(at)
  const settings = await loadSettings(supabase)
  const unit = Number(settings.rounding_minutes) || 30
  const shifts = await dayShifts(supabase, staff.id, date)
  const shift = chooseShift(shifts, kind, site?.id || null)
  const flags = []
  if (method === 'proxy') flags.push('proxy')
  if (offline) flags.push('offline')
  if (!shift) flags.push('no_plan')
  else if (site && shift.site_id && shift.site_id !== site.id) flags.push('site_mismatch')

  if (method === 'qr') {
    if (lat == null || lng == null) flags.push('no_location')
    else if (site?.lat != null && site?.lng != null) {
      const d = distanceM(lat, lng, site.lat, site.lng)
      if (d > (site.radius_m || 300) + Math.min(Number(accuracy) || 0, 500)) flags.push('far')
    }
  }

  let setStart = null
  let setEnd = null
  const adopted = adoptedTime(kind, time, shift, unit)
  if (kind === 'in') {
    // 代理入力は訂正も兼ねるので上書きする。QR の二重読み取りは採用時刻を変えない
    if (shift?.actual_start && method === 'qr') flags.push('duplicate')
    else if (shift) setStart = adopted
  } else {
    const hasIn = shift?.actual_start
    if (!hasIn && !confirm && method === 'qr') {
      return { needsConfirm: true, message: '今日の出勤の記録がありません。退勤だけ記録しますか？' }
    }
    if (!hasIn) flags.push('no_in')
    if (shift?.actual_end && method === 'qr') flags.push('duplicate')
    else if (shift) setEnd = toMin(adopted) < toMin(shift.actual_start || shift.plan_start) ? hm(shift.actual_start || shift.plan_start) : adopted
  }

  const distance =
    lat != null && lng != null && site?.lat != null && site?.lng != null ? distanceM(lat, lng, site.lat, site.lng) : null
  const punch = {
    staff_id: staff.id,
    work_date: date,
    kind,
    punched_at: at.toISOString(),
    device_at: deviceAt ? deviceAt.toISOString() : null,
    method,
    site_id: site?.id || shift?.site_id || null,
    shift_id: shift?.id || null,
    adopted: kind === 'in' ? setStart || adopted : setEnd || adopted,
    lat: lat ?? null,
    lng: lng ?? null,
    accuracy_m: accuracy ?? null,
    distance_m: distance,
    flags,
    note: note || null,
    created_by: actor?.id || null,
  }
  const { data: id, error } = await supabase.rpc('works_record_punch', { p_punch: punch, p_start: setStart, p_end: setEnd })
  if (error) throw error

  let minutes = null
  if (shift && kind === 'out' && (setEnd || shift.actual_end)) {
    const start = hm(shift.actual_start) || hm(shift.plan_start)
    const end = setEnd || hm(shift.actual_end)
    minutes = shiftMinutes(start, end, { windows: settings.break_windows || [] }).minutes
  }
  return {
    id,
    kind,
    date,
    time,
    adopted: punch.adopted,
    flags,
    flag_labels: flags.map((f) => FLAG_LABEL[f] || f),
    shift: shift ? { plan_start: hm(shift.plan_start), plan_end: hm(shift.plan_end) } : null,
    minutes,
  }
}

// GET /api/works/punch/today
export async function handlePunchToday(req) {
  const { ctx, error } = await requireWorks(req)
  if (error) return error
  if (!ctx.staff) return json({ error: 'スタッフ情報が紐づいていません。管理者にお問い合わせください' }, 403)
  const supabase = getAdminClient()
  const date = todayJst()
  const [shifts, { data: punches, error: e }, { data: sites }] = await Promise.all([
    dayShifts(supabase, ctx.staff.id, date),
    supabase.from('works_punches').select('kind, punched_at, adopted, flags, site_id').eq('staff_id', ctx.staff.id).eq('work_date', date).order('punched_at'),
    supabase.from('works_sites').select('id, code, name'),
  ])
  if (e) throw e
  const siteMap = new Map((sites || []).map((s) => [s.id, s]))
  const working = shifts.some((s) => s.actual_start && !s.actual_end) || (!shifts.length && punches.length && punches[punches.length - 1].kind === 'in')
  const done = shifts.length ? shifts.every((s) => s.actual_end) : punches.some((p) => p.kind === 'out')
  return json({
    date,
    state: working ? 'working' : done ? 'done' : 'before',
    shifts: shifts.map((s) => ({
      id: s.id,
      plan_start: hm(s.plan_start),
      plan_end: hm(s.plan_end),
      actual_start: hm(s.actual_start),
      actual_end: hm(s.actual_end),
      site: siteMap.get(s.site_id) ? { code: siteMap.get(s.site_id).code, name: siteMap.get(s.site_id).name } : null,
    })),
    punches: (punches || []).map((p) => ({ ...p, time: jstParts(new Date(p.punched_at)).time, adopted: hm(p.adopted), site: siteMap.get(p.site_id)?.name || null })),
  })
}

// POST /api/works/punch
export async function handlePunch(req) {
  const { ctx, error } = await requireWorks(req)
  if (error) return error
  if (!ctx.staff) return json({ error: 'スタッフ情報が紐づいていません。管理者にお問い合わせください' }, 403)
  if (ctx.staff.status === 'retired') return json({ error: '退職済みのため記録できません' }, 403)
  const b = await req.json().catch(() => ({}))
  const kind = b.k
  if (kind !== 'in' && kind !== 'out') return json({ error: 'QR コードが正しくありません' }, 400)
  if (!b.c || !b.t || String(b.c).length > 40 || String(b.t).length > 100) return json({ error: 'QR コードが正しくありません' }, 400)
  const supabase = getAdminClient()
  const { data: site } = await supabase
    .from('works_sites')
    .select('id, code, name, lat, lng, radius_m, qr_secret_hash, active')
    .eq('code', String(b.c))
    .maybeSingle()
  if (!site || !site.qr_secret_hash || site.qr_secret_hash !== (await sha256Hex(String(b.t)))) {
    return json({ error: 'この QR コードは使えません。新しい掲示物の QR を読んでください' }, 400)
  }
  if (!site.active) return json({ error: 'この現場は停止中です。管理者にお問い合わせください' }, 400)

  const now = new Date()
  let at = now
  let deviceAt = null
  if (b.device_at) {
    const d = new Date(b.device_at)
    if (!Number.isNaN(d.getTime())) deviceAt = d
  }
  const offline = !!b.offline && !!deviceAt
  if (offline && now - deviceAt < OFFLINE_MAX_AGE_MS && deviceAt - now < FUTURE_SLACK_MS) at = deviceAt
  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v))
  const lat = num(b.lat)
  const lng = num(b.lng)

  const r = await recordPunch(supabase, {
    staff: ctx.staff,
    kind,
    at,
    method: 'qr',
    site,
    lat: lat != null && Math.abs(lat) <= 90 ? lat : null,
    lng: lng != null && Math.abs(lng) <= 180 ? lng : null,
    accuracy: num(b.accuracy),
    deviceAt,
    offline,
    confirm: !!b.confirm || offline,
    actor: ctx.user,
  })
  if (r.needsConfirm) return json({ needs_confirm: true, message: r.message }, 409)
  return json({ ...r, site: { code: site.code, name: site.name } })
}

// POST /api/works/punch/proxy（管理者の代理入力。スマートフォンを持たない方・打刻忘れの訂正）
export async function handlePunchProxy(req) {
  const { ctx, error } = await requireWorks(req, { admin: true })
  if (error) return error
  const b = await req.json().catch(() => ({}))
  if (!UUID_RE.test(String(b.staff_id || ''))) return json({ error: 'スタッフが正しくありません' }, 400)
  if (!DATE_RE.test(String(b.work_date || ''))) return json({ error: '日付が正しくありません' }, 400)
  if (b.kind !== 'in' && b.kind !== 'out') return json({ error: '出勤・退勤の区別が正しくありません' }, 400)
  if (!TIME_RE.test(String(b.time || ''))) return json({ error: '時刻が正しくありません' }, 400)
  const supabase = getAdminClient()
  const { data: staff } = await supabase.from('works_staff').select('id, code, name, status').eq('id', b.staff_id).maybeSingle()
  if (!staff) return json({ error: 'スタッフが見つかりません' }, 404)
  const at = new Date(`${b.work_date}T${b.time}:00+09:00`)
  const r = await recordPunch(supabase, {
    staff,
    kind: b.kind,
    at,
    method: 'proxy',
    site: null,
    confirm: true,
    note: b.note ? String(b.note).slice(0, 200) : null,
    actor: ctx.user,
  })
  return json(r)
}

// GET /api/works/punches?staff_id&date
export async function handlePunches(req) {
  const { ctx, error } = await requireWorks(req)
  if (error) return error
  const url = new URL(req.url)
  const date = url.searchParams.get('date')
  let staffId = url.searchParams.get('staff_id')
  if (!DATE_RE.test(String(date || ''))) return json({ error: '日付が正しくありません' }, 400)
  if (!ctx.isAdmin) {
    if (!ctx.staff) return json({ error: 'スタッフ情報が紐づいていません' }, 403)
    staffId = ctx.staff.id
  } else if (!UUID_RE.test(String(staffId || ''))) return json({ error: 'スタッフが正しくありません' }, 400)
  const supabase = getAdminClient()
  const [{ data, error: e }, { data: sites }] = await Promise.all([
    supabase
      .from('works_punches')
      .select('id, kind, punched_at, method, site_id, adopted, flags, distance_m, note, created_by')
      .eq('staff_id', staffId)
      .eq('work_date', date)
      .order('punched_at'),
    supabase.from('works_sites').select('id, name'),
  ])
  if (e) throw e
  const siteMap = new Map((sites || []).map((s) => [s.id, s.name]))
  return json({
    items: (data || []).map((p) => ({
      id: p.id,
      kind: p.kind,
      time: jstParts(new Date(p.punched_at)).time,
      method: p.method,
      site: siteMap.get(p.site_id) || null,
      adopted: hm(p.adopted),
      flags: p.flags,
      flag_labels: (p.flags || []).map((f) => FLAG_LABEL[f] || f),
      distance_m: ctx.isAdmin ? p.distance_m : undefined,
      note: p.note,
    })),
  })
}
