// 検針管理（FileMaker「検針記録」の移植）の API ハンドラ（Phase 1。2026-10-20〜。docs/meter-plan.md）。
//
// 権限: 社員（staff/admin）だけ。小泉産業様（owner）・備品出庫限定ロールには閲覧も許さない（Q9）。
// テナントの基本情報（profile。防火管理者・緊急連絡先など個人情報を含む）もここでだけ返す。
//
// Phase 2（写真の取込・値の入力・検証）は下の方の「月度の作業」。
//
// Phase 1 はマスタ（テナント・メータ・空調機の割当て・定数）の参照と修正、FileMaker の CSV の取込、
// 出力の照合用に月度のデータを返すところまで。取込は画面（src/pages/MeterMasters.jsx）が CSV を
// 読んで種類ごと・数百件ずつ送ってくる（Workers の1回あたりの外部リクエスト数の上限があるため、
// 1回の呼び出しの中では件数によらず数回の upsert で済むようにしてある）。

import { json, verifyRequestAuth, canWrite } from './http.js'
import { getAdminClient } from './supabase-admin.js'
import { putObject, getObject, deleteObject, deleteObjects } from './storage.js'

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIME_PATTERN = /^\d{2}:\d{2}:\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const METER_KINDS = new Set(['電気', 'ガス', '水道'])

const TENANT_COLUMNS =
  'id, billing_code, name, short_name, floor, moved_out, moved_out_on, note, source, moved_in_on, first_month_billable, profile, notice_emails, synced_at, updated_at'
const METER_COLUMNS =
  'id, meter_no, room_no, tenant_id, seq, floor, room_name, seal_label, detail_note, kind, sort_order, digits, ' +
  'max_value, expires_on, measured, removed, area_m2, area_tsubo, oa_share, oa_ratio, is_oa_meter, note, legacy_id, created_at, updated_at'
const READING_COLUMNS =
  'id, meter_id, month, read_on, read_time, value, value2, prev_override, diff_override, legacy_prev, legacy_prev2, ' +
  'legacy_diff, legacy_diff2, billing_code, note, recorded_by, verified_by, verified_at, legacy_id'

// 定数（settings のキー）。画面の項目名と既定値
const CONSTANTS = {
  oa_coefficient: { key: 'meter_oa_coefficient', fallback: 40 },
  total_area: { key: 'meter_total_area', fallback: 3300.07 },
  oa_target_area: { key: 'meter_oa_target_area', fallback: 2578.28 },
}

// 1回の取込で受け付ける件数（画面はこれより小さく区切って送る）
const MAX_IMPORT_RECORDS = 1000

async function requireStaff(req) {
  const auth = await verifyRequestAuth(req)
  if (!auth) return { error: json({ error: '認証が必要です' }, 401) }
  if (!canWrite(auth)) return { error: json({ error: 'この画面を使う権限がありません' }, 403) }
  return { auth }
}

// 検針マスタ（テナント・メータ・空調機）を書き換えた人。変更履歴（meter_master_history。DB のトリガーが記録）の
// 「変更者」になるので、これらの表に書き込むときは必ず updated_by に入れる（2026-10-21〜）
export function actorOf(auth) {
  return (auth?.display_name || auth?.username || '社員').slice(0, 100)
}

// 変更理由（任意。保存の画面のダイアログで入れる）を、いま記録された変更履歴に付ける（2026-10-21〜）。
// 履歴はトリガーが書くので、書き込みのあとで「その行の、since 以降の最新の記録」に入れる。何も変わっていなければ記録が無く何もしない
// 時計のずれ（Worker と DB）を見込んで少し前から探す
const reasonSince = () => new Date(Date.now() - 5000).toISOString()

async function attachChangeReason(supabase, table, key, reason, since) {
  if (!reason || key == null) return
  const { data } = await supabase
    .from('meter_master_history')
    .select('id')
    .eq('table_name', table)
    .eq('row_key', String(key))
    .gte('changed_at', since)
    .order('id', { ascending: false })
    .limit(1)
  if (!data?.length) return
  const { error } = await supabase.from('meter_master_history').update({ reason }).eq('id', data[0].id)
  if (error) console.error('meter-history(reason):', error.message)
}

// ---------- 値の整え ----------

function text(value, max = 500) {
  if (typeof value !== 'string') return null
  const t = value.replace(/\r\n?/g, '\n').trim()
  return t ? t.slice(0, max) : null
}

function num(value) {
  if (value === '' || value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function int(value) {
  const n = num(value)
  return n == null ? null : Math.trunc(n)
}

function dateOrNull(value) {
  return typeof value === 'string' && DATE_PATTERN.test(value) ? value : null
}

function timeOrNull(value) {
  return typeof value === 'string' && TIME_PATTERN.test(value) ? value : null
}

function isoOrNull(value) {
  if (typeof value !== 'string') return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const PROFILE_TEXT_KEYS = [
  'security_block',
  'representative',
  'phone',
  'email',
  'usage',
  'fire_manager',
  'fire_manager_title',
  'fire_manager_note',
  'legacy_tenant_code',
  'fix_note',
  // テナント一覧表・緊急連絡先一覧表（Excel 出力）のための項目（2026-10-21〜）
  'room_label',
  'plate_name',
  'company_phone',
  'update_info',
  // 緊急連絡先一覧表（PDF）の最終変更事項（連絡用。2026-10-26〜）
  'contact_change_note',
]

// テナントの基本情報（profile）を、決まったキーだけの形に整える
function cleanProfile(p) {
  if (!p || typeof p !== 'object') return {}
  const out = {}
  for (const key of PROFILE_TEXT_KEYS) {
    const v = text(p[key], 500)
    if (v) out[key] = v
  }
  const capacity = int(p.capacity)
  if (capacity != null) out.capacity = capacity
  const appointed = dateOrNull(p.fire_manager_appointed_on)
  if (appointed) out.fire_manager_appointed_on = appointed
  const entryDate = dateOrNull(p.entry_date)
  if (entryDate) out.entry_date = entryDate
  const contactChanged = dateOrNull(p.contact_changed_on)
  if (contactChanged) out.contact_changed_on = contactChanged
  if (p.list_exclude === true) out.list_exclude = true
  if (Array.isArray(p.emergency_contacts)) {
    const contacts = p.emergency_contacts
      .slice(0, 5)
      .map((c) => ({
        name: text(c?.name, 100),
        kana: text(c?.kana, 100),
        phone: text(c?.phone, 50),
        mobile: text(c?.mobile, 50),
      }))
      .filter((c) => c.name || c.kana || c.phone || c.mobile)
    if (contacts.length) out.emergency_contacts = contacts
  }
  return out
}

function meterFields(p, tenantIdByCode) {
  const row = {
    room_no: text(p.room_no, 50),
    seq: int(p.seq),
    floor: text(p.floor, 10),
    room_name: text(p.room_name, 100),
    seal_label: text(p.seal_label, 100),
    detail_note: text(p.detail_note, 100),
    kind: METER_KINDS.has(p.kind) ? p.kind : null,
    sort_order: int(p.sort_order),
    digits: (() => {
      const d = int(p.digits)
      return d != null && d >= 1 && d <= 9 ? d : null
    })(),
    // メータ最大値は桁数から決まる（10の桁数乗。2026-10-21〜 入力しない）。
    // 当月値が前月値より小さいとき、差分に足して一巡を戻すのに使う（src/lib/meterOutput.js の readingUsage）
    max_value: null,
    expires_on: dateOrNull(p.expires_on),
    measured: p.measured === true,
    removed: p.removed === true,
    area_m2: num(p.area_m2),
    area_tsubo: num(p.area_tsubo),
    oa_share: p.oa_share === true,
    // 外調機電気量の按分比率（oa_ratio）は入力しない。保存のたびに meter_recompute_oa_ratios で
    // 部屋面積 ÷ 按分対象の面積の合計（小数第4位まで）に計算し直す（2026-10-21〜）
    is_oa_meter: p.is_oa_meter === true,
    note: text(p.note, 2000),
  }
  row.max_value = row.digits != null ? 10 ** row.digits : null
  if (tenantIdByCode) {
    row.tenant_id = p.billing_code ? tenantIdByCode.get(String(p.billing_code)) || null : null
  } else if ('tenant_id' in p) {
    row.tenant_id = typeof p.tenant_id === 'string' && UUID_RE.test(p.tenant_id) ? p.tenant_id : null
  }
  return row
}

async function loadConstants(supabase) {
  const keys = Object.values(CONSTANTS).map((c) => c.key)
  const { data, error } = await supabase.from('settings').select('key, value').in('key', keys)
  if (error) throw new Error(error.message)
  const map = new Map((data || []).map((r) => [r.key, r.value]))
  const out = {}
  for (const [name, { key, fallback }] of Object.entries(CONSTANTS)) {
    const n = Number(map.get(key))
    out[name] = Number.isFinite(n) ? n : fallback
  }
  return out
}

// 外調機の按分（2026-10-21〜）: 按分対象の面積（定数 meter_oa_target_area）＝ oa_share のメータの部屋面積の合計、
// 各メータの按分比率 ＝ 部屋面積 ÷ その合計（小数第4位で丸め。面積の無いメータは0）。DB の関数1回で済ませる
async function recomputeOaRatios(supabase) {
  const { error } = await supabase.rpc('meter_recompute_oa_ratios')
  if (error) throw new Error(`按分比率の計算に失敗しました: ${error.message}`)
}

// numeric 列は文字列で返ることがあるので数値にそろえる
const toNum = (v) => (v == null ? null : Number(v))

function numericReading(r) {
  return {
    ...r,
    value: toNum(r.value),
    value2: toNum(r.value2),
    prev_override: toNum(r.prev_override),
    diff_override: toNum(r.diff_override),
    legacy_prev: toNum(r.legacy_prev),
    legacy_prev2: toNum(r.legacy_prev2),
    legacy_diff: toNum(r.legacy_diff),
    legacy_diff2: toNum(r.legacy_diff2),
  }
}

function numericMeter(mt) {
  return { ...mt, area_m2: toNum(mt.area_m2), area_tsubo: toNum(mt.area_tsubo), oa_ratio: toNum(mt.oa_ratio) }
}

// ============================================================
// マスタ
// ============================================================

// GET /api/meter/masters — テナント（退去済みも）・メータ・空調機・定数と、取り込んだ件数
export async function handleMeterMasters(req) {
  const { error } = await requireStaff(req)
  if (error) return error
  try {
    const supabase = getAdminClient()
    const [tenants, meters, units, constants, readingCount, latestReading, usageCount, latestUsage] = await Promise.all([
      supabase.from('equipment_tenants').select(TENANT_COLUMNS).order('floor').order('billing_code'),
      supabase.from('meters').select(METER_COLUMNS).order('floor').order('sort_order').order('meter_no'),
      supabase.from('meter_ac_units').select('unit_no, address, meter_id').order('unit_no'),
      loadConstants(supabase),
      supabase.from('meter_readings').select('id', { count: 'exact', head: true }),
      supabase.from('meter_readings').select('month').order('month', { ascending: false }).limit(1),
      supabase.from('meter_ac_usage').select('id', { count: 'exact', head: true }),
      supabase.from('meter_ac_usage').select('month').order('month', { ascending: false }).limit(1),
    ])
    const failed = [tenants, meters, units, readingCount, latestReading, usageCount, latestUsage].find((r) => r.error)
    if (failed) {
      console.error('meter-masters:', failed.error.message)
      return json({ error: 'マスタの取得に失敗しました' }, 500)
    }
    return json({
      tenants: tenants.data || [],
      meters: meters.data || [],
      acUnits: units.data || [],
      constants,
      counts: {
        readings: readingCount.count || 0,
        latestReadingMonth: latestReading.data?.[0]?.month || null,
        acUsage: usageCount.count || 0,
        latestAcUsageMonth: latestUsage.data?.[0]?.month || null,
      },
    })
  } catch (err) {
    console.error('meter-masters 失敗:', err)
    return json({ error: 'マスタの取得に失敗しました' }, 500)
  }
}

// テナントの退去（2026-10-20〜）: 退去日（moved_out_on）を入れて表す。前もって入れておけば、その日が来るまでは
// 入居中のまま。その日になったら moved_out=true にする（保存のとき・毎日3時の定期実行・FileMaker からの同期のあと）。
// 退去日の無い退去済み（それより前に FileMaker で退去になったもの）は moved_out をそのまま使う
function movedOutFor(movedOutOn, legacyMovedOut) {
  return movedOutOn ? movedOutOn <= jstNow().date : legacyMovedOut === true
}

// 退去日を過ぎたテナントを退去済みにする。1回の通信で済む
export async function applyTenantMoveOuts(supabase = getAdminClient()) {
  const { data, error } = await supabase
    .from('equipment_tenants')
    .update({ moved_out: true, updated_by: '自動（退去日の到来）' })
    .lte('moved_out_on', jstNow().date)
    .eq('moved_out', false)
    .select('id')
  if (error) throw new Error(error.message)
  return data?.length || 0
}

// テナントの項目（追加・修正で共通）。p に無い項目は触らない
function tenantFields(p) {
  const patch = {}
  if ('name' in p) {
    const name = text(p.name, 200)
    if (!name) return { error: '正式名称を入力してください' }
    patch.name = name
  }
  if ('billing_code' in p) {
    const code = text(p.billing_code, 50)
    if (!code) return { error: '請求先コードを入力してください' }
    patch.billing_code = code
  }
  if ('short_name' in p) patch.short_name = text(p.short_name, 100)
  if ('floor' in p) patch.floor = text(p.floor, 10)
  if ('note' in p) patch.note = text(p.note, 500)
  if ('moved_out_on' in p || 'moved_out' in p) {
    const movedOutOn = dateOrNull(p.moved_out_on)
    patch.moved_out_on = movedOutOn
    patch.moved_out = movedOutFor(movedOutOn, p.moved_out)
  }
  if ('moved_in_on' in p) patch.moved_in_on = dateOrNull(p.moved_in_on)
  if ('notice_emails' in p) {
    // ビルメン案内メールの宛先（2026-10-20〜）。配列か、改行・カンマ区切りの文字列で受ける
    const list = Array.isArray(p.notice_emails) ? p.notice_emails : String(p.notice_emails ?? '').split(/[\s,、;]+/)
    const emails = [...new Set(list.map((e) => String(e).trim().toLowerCase()).filter(Boolean))]
    const bad = emails.find((e) => !/^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/.test(e))
    if (bad) return { error: `案内メールの宛先「${bad}」の形式が正しくありません` }
    if (emails.length > 10) return { error: '案内メールの宛先は10件までです' }
    patch.notice_emails = emails
  }
  if ('first_month_billable' in p) patch.first_month_billable = p.first_month_billable === true
  if ('profile' in p) patch.profile = cleanProfile(p.profile)
  return { patch }
}

function tenantSaveError(err, label) {
  if (err.code === '23505') return json({ error: 'この請求先コードは、ほかのテナントで使われています' }, 409)
  console.error(`${label}:`, err.message)
  return json({ error: 'テナントの保存に失敗しました' }, 500)
}

// GET /api/meter/tenants — テナントマスタ（退去済みも。基本情報 profile を含む）
// POST /api/meter/tenants — テナントの追加（source='manual'）
// PATCH /api/meter/tenants — 修正。並行運用の間は FileMaker からの同期が名称・略称・階・備考を上書きする
export async function handleMeterTenants(req) {
  const { auth, error } = await requireStaff(req)
  if (error) return error
  try {
    const supabase = getAdminClient()
    if (req.method === 'GET') {
      const { data, error: err } = await supabase.from('equipment_tenants').select(TENANT_COLUMNS).order('floor').order('billing_code')
      if (err) {
        console.error('meter-tenants:', err.message)
        return json({ error: 'テナントの取得に失敗しました' }, 500)
      }
      return json({ tenants: data || [] })
    }

    const p = await req.json().catch(() => null)
    if (!p || typeof p !== 'object') return json({ error: '内容が正しくありません' }, 400)
    const { patch, error: fieldErr } = tenantFields(p)
    if (fieldErr) return json({ error: fieldErr }, 400)
    const by = actorOf(auth)
    const reason = text(p.reason, 500)
    const since = reasonSince()

    if (req.method === 'POST') {
      if (!patch.name || !patch.billing_code) return json({ error: '請求先コードと正式名称は必須です' }, 400)
      const { data, error: err } = await supabase
        .from('equipment_tenants')
        .insert({ ...patch, source: 'manual', updated_by: by })
        .select(TENANT_COLUMNS)
        .single()
      if (err) return tenantSaveError(err, 'meter-tenant-create')
      await attachChangeReason(supabase, 'equipment_tenants', data.id, reason, since)
      return json({ tenant: data })
    }

    const id = typeof p.id === 'string' && UUID_RE.test(p.id) ? p.id : null
    if (!id) return json({ error: 'id は必須です' }, 400)
    if (Object.keys(patch).length === 0) return json({ error: '更新する項目がありません' }, 400)
    const { data, error: err } = await supabase
      .from('equipment_tenants')
      .update({ ...patch, updated_by: by })
      .eq('id', id)
      .select(TENANT_COLUMNS)
      .maybeSingle()
    if (err) return tenantSaveError(err, 'meter-tenant-update')
    if (!data) return json({ error: 'テナントが見つかりません' }, 404)
    await attachChangeReason(supabase, 'equipment_tenants', data.id, reason, since)
    return json({ tenant: data })
  } catch (err) {
    console.error('meter-tenants 失敗:', err)
    return json({ error: 'テナントの保存に失敗しました' }, 500)
  }
}

// 按分比率を計算し直したあとの値で返す（読み直せなければ保存直後の値）
async function reloadMeter(supabase, saved) {
  const { data } = await supabase.from('meters').select(METER_COLUMNS).eq('id', saved.id).maybeSingle()
  return data || saved
}

// POST /api/meter/meters（追加）・PATCH /api/meter/meters（修正。id 必須）。
// 保存のあと、すべてのメータの按分比率と按分対象の面積を計算し直す（画面は一覧を読み直す）
export async function handleMeterSave(req) {
  const { auth, error } = await requireStaff(req)
  if (error) return error
  try {
    const p = await req.json().catch(() => null)
    if (!p || typeof p !== 'object') return json({ error: '内容が読み取れませんでした' }, 400)
    const row = { ...meterFields(p), updated_by: actorOf(auth) }
    const supabase = getAdminClient()
    const reason = text(p.reason, 500)
    const since = reasonSince()
    if (req.method === 'POST') {
      const meterNo = text(p.meter_no, 50)
      if (!meterNo) return json({ error: 'メータ番号を入力してください' }, 400)
      const { data, error: err } = await supabase
        .from('meters')
        .insert({ ...row, meter_no: meterNo })
        .select(METER_COLUMNS)
        .single()
      if (err) {
        const dup = err.code === '23505'
        if (!dup) console.error('meter-create:', err.message)
        return json({ error: dup ? 'そのメータ番号はすでにあります' : 'メータの追加に失敗しました' }, dup ? 409 : 500)
      }
      await recomputeOaRatios(supabase)
      await attachChangeReason(supabase, 'meters', data.id, reason, since)
      return json({ meter: await reloadMeter(supabase, data) })
    }
    const id = typeof p.id === 'string' && UUID_RE.test(p.id) ? p.id : null
    if (!id) return json({ error: 'id は必須です' }, 400)
    if ('meter_no' in p) {
      const meterNo = text(p.meter_no, 50)
      if (!meterNo) return json({ error: 'メータ番号を入力してください' }, 400)
      row.meter_no = meterNo
    }
    const { data, error: err } = await supabase
      .from('meters')
      .update(row)
      .eq('id', id)
      .select(METER_COLUMNS)
      .maybeSingle()
    if (err) {
      const dup = err.code === '23505'
      if (!dup) console.error('meter-update:', err.message)
      return json({ error: dup ? 'そのメータ番号はすでにあります' : 'メータの更新に失敗しました' }, dup ? 409 : 500)
    }
    if (!data) return json({ error: 'メータが見つかりません' }, 404)
    await recomputeOaRatios(supabase)
    await attachChangeReason(supabase, 'meters', data.id, reason, since)
    return json({ meter: await reloadMeter(supabase, data) })
  } catch (err) {
    console.error('meter-save 失敗:', err)
    return json({ error: 'メータの保存に失敗しました' }, 500)
  }
}

// PATCH /api/meter/ac-units — 室内機の割当てメータを変える { unit_no, meter_id }
export async function handleMeterAcUnitUpdate(req) {
  const { auth, error } = await requireStaff(req)
  if (error) return error
  try {
    const p = await req.json().catch(() => null)
    const unitNo = int(p?.unit_no)
    if (unitNo == null) return json({ error: 'unit_no は必須です' }, 400)
    const meterId = typeof p?.meter_id === 'string' && UUID_RE.test(p.meter_id) ? p.meter_id : null
    const supabase = getAdminClient()
    const since = reasonSince()
    const { data, error: err } = await supabase
      .from('meter_ac_units')
      .update({ meter_id: meterId, updated_by: actorOf(auth) })
      .eq('unit_no', unitNo)
      .select('unit_no, address, meter_id')
      .maybeSingle()
    if (err) {
      console.error('meter-ac-unit-update:', err.message)
      return json({ error: '空調機の割当ての保存に失敗しました' }, 500)
    }
    if (!data) return json({ error: '空調機が見つかりません' }, 404)
    await attachChangeReason(supabase, 'meter_ac_units', data.unit_no, text(p.reason, 500), since)
    return json({ unit: data })
  } catch (err) {
    console.error('meter-ac-unit-update 失敗:', err)
    return json({ error: '空調機の割当ての保存に失敗しました' }, 500)
  }
}

// PUT /api/meter/constants — 外調データ係数・総面積・按分対象面積
export async function handleMeterConstantsUpdate(req) {
  const { error } = await requireStaff(req)
  if (error) return error
  try {
    const p = await req.json().catch(() => null)
    const rows = []
    for (const [name, { key }] of Object.entries(CONSTANTS)) {
      // 按分対象の面積はメータから計算する（recomputeOaRatios）ので受け付けない
      if (name === 'oa_target_area') continue
      if (!(name in (p || {}))) continue
      const n = num(p[name])
      if (n == null || n < 0) return json({ error: '定数は0以上の数で入力してください' }, 400)
      rows.push({ key, value: String(n) })
    }
    if (rows.length === 0) return json({ error: '更新する項目がありません' }, 400)
    const supabase = getAdminClient()
    const { error: err } = await supabase.from('settings').upsert(rows, { onConflict: 'key' })
    if (err) {
      console.error('meter-constants:', err.message)
      return json({ error: '定数の保存に失敗しました' }, 500)
    }
    return json({ constants: await loadConstants(supabase) })
  } catch (err) {
    console.error('meter-constants 失敗:', err)
    return json({ error: '定数の保存に失敗しました' }, 500)
  }
}

// ============================================================
// FileMaker の CSV の取込（POST /api/meter/import { kind, records }）
// 種類ごとに送る。順番は tenants → meters → ac_units → readings → ac_usage
// （後の種類は前の種類で入ったテナント・メータを引くため）。何度流し直しても同じ結果になる。
// ============================================================

async function importTenants(supabase, records, by) {
  const { data: existing, error } = await supabase.from('equipment_tenants').select('id, billing_code, name')
  if (error) throw new Error(error.message)
  const byCode = new Map(existing.filter((t) => t.billing_code).map((t) => [t.billing_code, t]))
  const squash = (s) => (s || '').replace(/\s+/g, '')
  const byName = new Map(existing.map((t) => [squash(t.name), t]))

  const withCode = []
  const updates = []
  const inserts = []
  for (const r of records) {
    const row = {
      name: text(r.name, 200),
      short_name: text(r.short_name, 100),
      floor: text(r.floor, 10),
      note: text(r.note, 500),
      moved_out: r.moved_out === true,
      moved_in_on: dateOrNull(r.moved_in_on),
      first_month_billable: r.first_month_billable === true,
      profile: cleanProfile(r.profile),
      updated_by: by,
    }
    if (!row.name) continue
    const code = text(r.billing_code, 20)
    if (code) {
      withCode.push({ ...row, billing_code: code })
      continue
    }
    // 請求先コードの無いテナント（退去済みの2件）は名称で突き合わせる
    const hit = byName.get(squash(row.name))
    if (hit && !hit.billing_code) updates.push({ id: hit.id, row })
    else inserts.push({ ...row, source: 'filemaker' })
  }
  const inserted = withCode.filter((r) => !byCode.has(r.billing_code)).length + inserts.length
  if (withCode.length) {
    const { error: err } = await supabase.from('equipment_tenants').upsert(withCode, { onConflict: 'billing_code' })
    if (err) throw new Error(err.message)
  }
  if (inserts.length) {
    const { error: err } = await supabase.from('equipment_tenants').insert(inserts)
    if (err) throw new Error(err.message)
  }
  for (const u of updates.slice(0, 20)) {
    const { error: err } = await supabase.from('equipment_tenants').update(u.row).eq('id', u.id)
    if (err) throw new Error(err.message)
  }
  return { saved: withCode.length + inserts.length + Math.min(updates.length, 20), inserted }
}

async function tenantIdMap(supabase) {
  const { data, error } = await supabase.from('equipment_tenants').select('id, billing_code').not('billing_code', 'is', null)
  if (error) throw new Error(error.message)
  return new Map(data.map((t) => [t.billing_code, t.id]))
}

async function meterIdMap(supabase) {
  const { data, error } = await supabase.from('meters').select('id, meter_no')
  if (error) throw new Error(error.message)
  return new Map(data.map((m) => [m.meter_no, m.id]))
}

async function importMeters(supabase, records, by) {
  const tenantIdByCode = await tenantIdMap(supabase)
  const rows = []
  const unknownCodes = new Set()
  for (const r of records) {
    const meterNo = text(r.meter_no, 50)
    if (!meterNo) continue
    if (r.billing_code && !tenantIdByCode.has(String(r.billing_code))) unknownCodes.add(String(r.billing_code))
    const row = { ...meterFields(r, tenantIdByCode), meter_no: meterNo, legacy_id: text(r.legacy_id, 64), updated_by: by }
    const created = isoOrNull(r.created_at)
    if (created) row.created_at = created
    rows.push(row)
  }
  if (rows.length) {
    const { error } = await supabase.from('meters').upsert(rows, { onConflict: 'meter_no' })
    if (error) throw new Error(error.message)
    await recomputeOaRatios(supabase)
  }
  return { saved: rows.length, warnings: [...unknownCodes].map((c) => `請求先コード ${c} のテナントがありません`) }
}

async function importAcUnits(supabase, records, by) {
  const meterIdByNo = await meterIdMap(supabase)
  const rows = records
    .map((r) => ({
      unit_no: int(r.unit_no),
      address: text(r.address, 50),
      meter_id: r.meter_no ? meterIdByNo.get(String(r.meter_no)) || null : null,
      updated_by: by,
    }))
    .filter((r) => r.unit_no != null && r.address)
  if (rows.length) {
    const { error } = await supabase.from('meter_ac_units').upsert(rows, { onConflict: 'unit_no' })
    if (error) throw new Error(error.message)
  }
  return { saved: rows.length }
}

async function importReadings(supabase, records) {
  const meterIdByNo = await meterIdMap(supabase)
  const rows = []
  let skippedMeter = 0
  for (const r of records) {
    const meterId = r.meter_no ? meterIdByNo.get(String(r.meter_no)) : null
    const month = typeof r.month === 'string' && MONTH_PATTERN.test(r.month) ? r.month : null
    const readOn = dateOrNull(r.read_on)
    if (!meterId || !month || !readOn) {
      skippedMeter++
      continue
    }
    const row = {
      meter_id: meterId,
      month,
      read_on: readOn,
      read_time: timeOrNull(r.read_time),
      value: num(r.value),
      value2: num(r.value2),
      prev_override: num(r.prev_override),
      diff_override: num(r.diff_override),
      legacy_prev: num(r.legacy_prev),
      legacy_prev2: num(r.legacy_prev2),
      legacy_diff: num(r.legacy_diff),
      legacy_diff2: num(r.legacy_diff2),
      billing_code: text(r.billing_code, 20),
      note: text(r.note, 2000),
      recorded_by: text(r.recorded_by, 100),
      legacy_id: text(r.legacy_id, 64),
    }
    const created = isoOrNull(r.created_at)
    if (created) row.created_at = created
    rows.push(row)
  }

  // アプリで入力した検針値（legacy_id が空）は FileMaker の値で上書きしない（並行運用の月）
  const months = [...new Set(rows.map((r) => r.month))]
  let keptApp = 0
  let toSave = rows
  if (months.length) {
    const { data: appRows, error } = await supabase
      .from('meter_readings')
      .select('meter_id, month')
      .is('legacy_id', null)
      .in('month', months)
    if (error) throw new Error(error.message)
    const appKeys = new Set((appRows || []).map((r) => `${r.meter_id}|${r.month}`))
    toSave = rows.filter((r) => !appKeys.has(`${r.meter_id}|${r.month}`))
    keptApp = rows.length - toSave.length
  }
  if (toSave.length) {
    const { error } = await supabase.from('meter_readings').upsert(toSave, { onConflict: 'meter_id,month' })
    if (error) throw new Error(error.message)
  }
  const warnings = []
  if (skippedMeter) warnings.push(`メータが見つからない検針値 ${skippedMeter}件を飛ばしました`)
  if (keptApp) warnings.push(`アプリで入力済みの検針値 ${keptApp}件は上書きしませんでした`)
  return { saved: toSave.length, warnings }
}

async function importAcUsage(supabase, records) {
  const rows = records
    .map((r) => ({
      month: typeof r.month === 'string' && MONTH_PATTERN.test(r.month) ? r.month : null,
      unit_no: int(r.unit_no),
      address: text(r.address, 50),
      hp_code: text(r.hp_code, 20),
      day_wh: int(r.day_wh),
      night_wh: int(r.night_wh),
      day_stop_wh: int(r.day_stop_wh),
      night_stop_wh: int(r.night_stop_wh),
      gas: int(r.gas),
      meter_no: text(r.meter_no, 50),
    }))
    .filter((r) => r.month && r.unit_no != null)
  if (rows.length) {
    const { error } = await supabase.from('meter_ac_usage').upsert(rows, { onConflict: 'month,unit_no' })
    if (error) throw new Error(error.message)
  }
  return { saved: rows.length }
}

const IMPORTERS = {
  tenants: importTenants,
  meters: importMeters,
  ac_units: importAcUnits,
  readings: importReadings,
  ac_usage: importAcUsage,
}

export async function handleMeterImport(req) {
  const { auth, error } = await requireStaff(req)
  if (error) return error
  try {
    const p = await req.json().catch(() => null)
    const importer = IMPORTERS[p?.kind]
    if (!importer) return json({ error: '取込の種類が不正です' }, 400)
    if (!Array.isArray(p.records) || p.records.length === 0) return json({ error: '取り込む行がありません' }, 400)
    if (p.records.length > MAX_IMPORT_RECORDS) return json({ error: `1回に送れるのは${MAX_IMPORT_RECORDS}件までです` }, 400)
    const supabase = getAdminClient()
    const result = await importer(supabase, p.records, `FileMaker取込（${actorOf(auth)}）`)
    if (p.last === true) {
      await supabase
        .from('activity_logs')
        .insert({
          log_type: 'status_change',
          actor: auth.display_name || auth.username || '検針',
          message: `検針: FileMaker の${p.label || p.kind}を取り込みました（${p.total ?? result.saved}件）`,
        })
        .then(
          () => {},
          (err) => console.error('meter-import(log):', err)
        )
    }
    return json({ ok: true, ...result })
  } catch (err) {
    console.error('meter-import 失敗:', err)
    return json({ error: `取込に失敗しました（${err.message}）` }, 500)
  }
}

// ============================================================
// GET /api/meter/output?month=YYYY-MM — 出力（検針データ_yyyy年mm月分）を組み立てるための材料。
// 組み立て自体は画面側の src/lib/meterOutput.js（照合・xlsx 出力と同じ関数）で行う
// ============================================================
export async function handleMeterOutputData(req) {
  const { error } = await requireStaff(req)
  if (error) return error
  try {
    const month = new URL(req.url).searchParams.get('month') || ''
    if (!MONTH_PATTERN.test(month)) return json({ error: 'month は YYYY-MM で指定してください' }, 400)
    const [y, m] = month.split('-').map(Number)
    const prevMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
    const supabase = getAdminClient()
    const [tenants, meters, readings, usage, constants] = await Promise.all([
      supabase.from('equipment_tenants').select('id, billing_code, name, short_name, floor, moved_out, moved_in_on, first_month_billable'),
      supabase.from('meters').select(METER_COLUMNS),
      supabase.from('meter_readings').select(READING_COLUMNS).in('month', [month, prevMonth]),
      supabase.from('meter_ac_usage').select('unit_no, day_wh, meter_no').eq('month', month),
      loadConstants(supabase),
    ])
    const failed = [tenants, meters, readings, usage].find((r) => r.error)
    if (failed) {
      console.error('meter-output:', failed.error.message)
      return json({ error: '出力の材料の取得に失敗しました' }, 500)
    }
    return json({
      month,
      tenants: tenants.data || [],
      meters: (meters.data || []).map(numericMeter),
      readings: (readings.data || []).map(numericReading),
      acUsage: (usage.data || []).map((u) => ({ ...u, day_wh: toNum(u.day_wh) })),
      constants,
    })
  } catch (err) {
    console.error('meter-output 失敗:', err)
    return json({ error: '出力の材料の取得に失敗しました' }, 500)
  }
}

// ============================================================
// 月度の作業（Phase 2。2026-10-20〜。docs/meter-plan.md 5章）
// 写真の取込（端末で Code39 を読んで縮小した写真が1枚ずつ届く）・検針一覧・値の入力
// ============================================================

const PHOTO_COLUMNS = 'id, month, meter_id, barcode, filename, width, height, size_bytes, taken_at, uploaded_by, created_at'
const PHOTO_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])
// 縮小済み（約20KB）が届く前提。縮小できなかった写真（HEIC など）も受けられるよう余裕を持たせる
const MAX_PHOTO_BYTES = 8 * 1024 * 1024

function actorName(auth) {
  return auth.display_name || auth.username || null
}

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

// 日本時間の今日と今の時刻（検針日付・時刻を写真から取れないとき）
function jstNow() {
  const d = new Date(Date.now() + 9 * 3600 * 1000).toISOString()
  return { date: d.slice(0, 10), time: d.slice(11, 19) }
}

// GET /api/meter/month?month=YYYY-MM — 検針一覧・値の入力の材料。
// 前月値・前月比を出すため、当月と前2か月の検針値を返す。写真は情報だけ（本体は /api/meter/photo）
export async function handleMeterMonth(req) {
  const { error } = await requireStaff(req)
  if (error) return error
  try {
    const month = new URL(req.url).searchParams.get('month') || ''
    if (!MONTH_PATTERN.test(month)) return json({ error: 'month は YYYY-MM で指定してください' }, 400)
    const supabase = getAdminClient()
    const [tenants, meters, readings, photos] = await Promise.all([
      supabase.from('equipment_tenants').select('id, billing_code, name, short_name, floor, moved_out, moved_in_on, first_month_billable'),
      supabase.from('meters').select(METER_COLUMNS),
      supabase
        .from('meter_readings')
        .select(READING_COLUMNS)
        .in('month', [month, shiftMonth(month, -1), shiftMonth(month, -2)]),
      supabase.from('meter_photos').select(PHOTO_COLUMNS).eq('month', month).order('taken_at', { ascending: true }),
    ])
    const failed = [tenants, meters, readings, photos].find((r) => r.error)
    if (failed) {
      console.error('meter-month:', failed.error.message)
      return json({ error: '検針データの取得に失敗しました' }, 500)
    }
    return json({
      month,
      tenants: tenants.data || [],
      meters: (meters.data || []).map(numericMeter),
      readings: (readings.data || []).map(numericReading),
      photos: photos.data || [],
    })
  } catch (err) {
    console.error('meter-month 失敗:', err)
    return json({ error: '検針データの取得に失敗しました' }, 500)
  }
}

// POST /api/meter/readings — 1メータ・1か月度の検針値を保存する（無ければ作る）。
// 移行した月の値を直したときは、FileMaker の保存値（legacy_*）を捨ててアプリの計算に切り替える
export async function handleMeterReadingSave(req) {
  const { auth, error } = await requireStaff(req)
  if (error) return error
  try {
    const p = await req.json().catch(() => null)
    if (!p || typeof p !== 'object') return json({ error: '内容が読み取れませんでした' }, 400)
    const month = String(p.month || '')
    if (!MONTH_PATTERN.test(month)) return json({ error: 'month は YYYY-MM で指定してください' }, 400)
    if (typeof p.meter_id !== 'string' || !UUID_RE.test(p.meter_id)) return json({ error: 'meter_id が不正です' }, 400)
    const supabase = getAdminClient()
    const [{ data: meter }, { data: existing }] = await Promise.all([
      supabase.from('meters').select('id, tenant_id').eq('id', p.meter_id).maybeSingle(),
      supabase.from('meter_readings').select(READING_COLUMNS).eq('meter_id', p.meter_id).eq('month', month).maybeSingle(),
    ])
    if (!meter) return json({ error: 'メータが見つかりません' }, 404)
    let billingCode = existing?.billing_code ?? null
    if (!existing && meter.tenant_id) {
      const { data: tenant } = await supabase.from('equipment_tenants').select('billing_code').eq('id', meter.tenant_id).maybeSingle()
      billingCode = tenant?.billing_code ?? null
    }

    const now = jstNow()
    const row = {
      meter_id: meter.id,
      month,
      read_on: dateOrNull(p.read_on) || existing?.read_on || now.date,
      read_time: timeOrNull(p.read_time) || existing?.read_time || now.time,
      value: num(p.value),
      value2: num(p.value2),
      prev_override: num(p.prev_override),
      diff_override: num(p.diff_override),
      note: text(p.note, 2000),
      billing_code: billingCode,
    }
    const same = (a, b) => (a == null ? null : Number(a)) === (b == null ? null : Number(b))
    const valueChanged = !existing || !same(existing.value, row.value) || !same(existing.value2, row.value2)
    if (valueChanged) row.recorded_by = actorName(auth)
    if (existing && valueChanged) {
      row.legacy_prev = null
      row.legacy_prev2 = null
      row.legacy_diff = null
      row.legacy_diff2 = null
    }
    if (p.verified === true) {
      // 値を変えたら確認し直し（ただし同じ保存で確認済みにした場合はそのまま）
      row.verified_by = actorName(auth)
      row.verified_at = new Date().toISOString()
    } else if (p.verified === false || valueChanged) {
      row.verified_by = null
      row.verified_at = null
    }
    const { data, error: err } = await supabase
      .from('meter_readings')
      .upsert(row, { onConflict: 'meter_id,month' })
      .select(READING_COLUMNS)
      .single()
    if (err) {
      console.error('meter-reading-save:', err.message)
      return json({ error: '検針値の保存に失敗しました' }, 500)
    }
    return json({ reading: numericReading(data) })
  } catch (err) {
    console.error('meter-reading-save 失敗:', err)
    return json({ error: '検針値の保存に失敗しました' }, 500)
  }
}

// POST /api/meter/photos（multipart）— 写真を1枚保存し、読めたバーコードでメータへ割り当てる
export async function handleMeterPhotoUpload(req) {
  const { auth, error } = await requireStaff(req)
  if (error) return error
  try {
    const form = await req.formData().catch(() => null)
    if (!form) return json({ error: 'ファイルの受け取りに失敗しました' }, 400)
    const month = String(form.get('month') || '')
    const file = form.get('file')
    if (!MONTH_PATTERN.test(month)) return json({ error: 'month は YYYY-MM で指定してください' }, 400)
    if (!file || typeof file === 'string') return json({ error: 'file は必須です' }, 400)
    if (file.size > MAX_PHOTO_BYTES) return json({ error: '写真が大きすぎます' }, 413)
    if (!PHOTO_MIME.has(file.type)) return json({ error: '対応していない形式です（JPEG で取り込んでください）' }, 415)

    const supabase = getAdminClient()
    const barcode = text(String(form.get('barcode') || ''), 50)
    let meterId = null
    if (barcode) {
      const { data: meter } = await supabase.from('meters').select('id').eq('meter_no', barcode).maybeSingle()
      meterId = meter?.id || null
    }
    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'
    const key = `meter/${month}/${crypto.randomUUID()}.${ext}`
    await putObject(key, file.stream(), file.type)

    const row = {
      month,
      meter_id: meterId,
      barcode,
      storage_key: key,
      mime: file.type,
      filename: text(String(form.get('filename') || ''), 200),
      width: int(form.get('width')),
      height: int(form.get('height')),
      size_bytes: file.size,
      taken_at: isoOrNull(String(form.get('taken_at') || '')),
      uploaded_by: actorName(auth),
    }
    const { data, error: err } = await supabase.from('meter_photos').insert(row).select(PHOTO_COLUMNS).single()
    if (err) {
      console.error('meter-photo-upload:', err.message)
      await deleteObject(key)
      return json({ error: '写真の保存に失敗しました' }, 500)
    }
    return json({ photo: data })
  } catch (err) {
    console.error('meter-photo-upload 失敗:', err)
    return json({ error: '写真の保存に失敗しました' }, 500)
  }
}

// PATCH /api/meter/photos — 読めなかった写真を手でメータへ割り当てる（meter_id: null で外す）
export async function handleMeterPhotoAssign(req) {
  const { error } = await requireStaff(req)
  if (error) return error
  try {
    const p = await req.json().catch(() => null)
    if (typeof p?.id !== 'string' || !UUID_RE.test(p.id)) return json({ error: 'id が不正です' }, 400)
    const meterId = typeof p.meter_id === 'string' && UUID_RE.test(p.meter_id) ? p.meter_id : null
    const { data, error: err } = await getAdminClient()
      .from('meter_photos')
      .update({ meter_id: meterId })
      .eq('id', p.id)
      .select(PHOTO_COLUMNS)
      .maybeSingle()
    if (err) {
      console.error('meter-photo-assign:', err.message)
      return json({ error: '写真の割り当てに失敗しました' }, 500)
    }
    if (!data) return json({ error: '写真が見つかりません' }, 404)
    return json({ photo: data })
  } catch (err) {
    console.error('meter-photo-assign 失敗:', err)
    return json({ error: '写真の割り当てに失敗しました' }, 500)
  }
}

// DELETE /api/meter/photos?id= — 写真を消す（撮り直した・別の建物を写した など）
export async function handleMeterPhotoDelete(req) {
  const { error } = await requireStaff(req)
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!UUID_RE.test(id)) return json({ error: 'id が不正です' }, 400)
    const supabase = getAdminClient()
    const { data: photo } = await supabase.from('meter_photos').select('storage_key').eq('id', id).maybeSingle()
    if (!photo) return json({ error: '写真が見つかりません' }, 404)
    const { error: err } = await supabase.from('meter_photos').delete().eq('id', id)
    if (err) {
      console.error('meter-photo-delete:', err.message)
      return json({ error: '写真の削除に失敗しました' }, 500)
    }
    await deleteObject(photo.storage_key)
    return json({ ok: true })
  } catch (err) {
    console.error('meter-photo-delete 失敗:', err)
    return json({ error: '写真の削除に失敗しました' }, 500)
  }
}

// GET /api/meter/photo?id= — 写真の本体（バケットは非公開なので必ずここを通す）
export async function handleMeterPhotoGet(req) {
  const { error } = await requireStaff(req)
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!UUID_RE.test(id)) return json({ error: 'id が不正です' }, 400)
    const { data: photo } = await getAdminClient().from('meter_photos').select('storage_key, mime').eq('id', id).maybeSingle()
    if (!photo) return json({ error: '写真が見つかりません' }, 404)
    const res = await getObject(photo.storage_key)
    if (!res.ok) {
      console.error('meter-photo-get: storage が', res.status, 'を返した')
      return json({ error: '写真の取得に失敗しました' }, 404)
    }
    return new Response(res.body, {
      status: 200,
      headers: { 'Content-Type': photo.mime || 'image/jpeg', 'Cache-Control': 'private, max-age=86400' },
    })
  } catch (err) {
    console.error('meter-photo-get 失敗:', err)
    return json({ error: '写真の取得に失敗しました' }, 500)
  }
}

// 2年を過ぎた検針写真を消す（Q10）。毎日1回、定期実行から呼ぶ。
// Workers の1回あたりの外部リクエスト数に収まるよう、1回50枚まで・ストレージは一括削除（計3回の通信）
export async function cleanupMeterPhotos() {
  const supabase = getAdminClient()
  const { data, error } = await supabase
    .from('meter_photos')
    .select('id, storage_key')
    .lt('delete_after', jstNow().date)
    .limit(50)
  if (error) throw new Error(error.message)
  if (!data?.length) return 0
  await deleteObjects(data.map((p) => p.storage_key))
  const { error: delErr } = await supabase.from('meter_photos').delete().in('id', data.map((p) => p.id))
  if (delErr) throw new Error(delErr.message)
  return data.length
}

// GET /api/meter/summary — ダッシュボードの「検針」カード用（2026-10-20〜）。
// 検針値のある最新の月度と、その前3か月分の検針値・メータを返す（電気の使用量の前月比は画面で計算する）
export async function handleMeterSummary(req) {
  const { error } = await requireStaff(req)
  if (error) return error
  try {
    const supabase = getAdminClient()
    const { data: latest, error: e1 } = await supabase
      .from('meter_readings')
      .select('month')
      .order('month', { ascending: false })
      .limit(1)
    if (e1) throw new Error(e1.message)
    const latestMonth = latest?.[0]?.month || null
    if (!latestMonth) return json({ latestMonth: null, meters: [], readings: [] })
    const months = [0, -1, -2, -3].map((d) => shiftMonth(latestMonth, d))
    const [meters, readings] = await Promise.all([
      supabase.from('meters').select('id, meter_no, tenant_id, floor, seq, kind, digits, max_value, measured, removed, is_oa_meter'),
      supabase.from('meter_readings').select(READING_COLUMNS).in('month', months),
    ])
    const failed = [meters, readings].find((r) => r.error)
    if (failed) throw new Error(failed.error.message)
    return json({ latestMonth, meters: meters.data || [], readings: (readings.data || []).map(numericReading) })
  } catch (err) {
    console.error('meter-summary 失敗:', err)
    return json({ error: '検針の集計に失敗しました' }, 500)
  }
}

// ============================================================
// 検針マスタの変更履歴（2026-10-21〜）。記録は DB のトリガー（meter_master_history_log）が行う。
// GET  /api/meter/history?table=&key=&limit= — 新しい順。table・key を渡すとその1件の履歴だけ
// PATCH /api/meter/history { id, reason } — 変更理由をあとから書く
// POST /api/meter/history/revert { id, force } — その変更を取り消す（変わった項目だけを変更前の値に戻す）。
//   取り消しも1件の変更として履歴に残る。変更のあとで同じ項目がさらに変わっていれば、force なしでは 409 を返す
// ============================================================

const HISTORY_TABLES = {
  equipment_tenants: { key: 'id' },
  meters: { key: 'id' },
  meter_ac_units: { key: 'unit_no' },
}
// 取り消しで戻さない列（識別子・自動で入る列）
const HISTORY_FIXED = new Set(['id', 'unit_no', 'created_at', 'updated_at', 'updated_by', 'synced_at', 'source', 'legacy_id', 'oa_ratio', 'max_value'])

export async function handleMeterHistory(req) {
  const { error } = await requireStaff(req)
  if (error) return error
  try {
    const url = new URL(req.url)
    const table = url.searchParams.get('table')
    const key = url.searchParams.get('key')
    // since（YYYY-MM-DD。日本時間のその日の0時から）を渡すと、それ以降の変更だけ（緊急連絡先一覧表 PDF の更新情報。2026-10-21〜）
    const since = url.searchParams.get('since')
    if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) return json({ error: 'since が不正です' }, 400)
    const limit = Math.min(Math.max(int(url.searchParams.get('limit')) || 200, 1), since ? 2000 : 500)
    let q = getAdminClient()
      .from('meter_master_history')
      .select('id, table_name, row_key, op, old_row, new_row, changed_fields, changed_by, changed_at, reason')
      .order('changed_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit)
    if (table) {
      if (!HISTORY_TABLES[table]) return json({ error: 'table が不正です' }, 400)
      q = q.eq('table_name', table)
      if (key) q = q.eq('row_key', key.slice(0, 64))
    }
    if (since) q = q.gte('changed_at', `${since}T00:00:00+09:00`)
    const { data, error: err } = await q
    if (err) {
      console.error('meter-history:', err.message)
      return json({ error: '変更履歴の取得に失敗しました' }, 500)
    }
    return json({ history: data || [] })
  } catch (err) {
    console.error('meter-history 失敗:', err)
    return json({ error: '変更履歴の取得に失敗しました' }, 500)
  }
}

// PATCH /api/meter/history { id, reason } — 変更理由をあとから書く（空にすると消す）
export async function handleMeterHistoryReason(req) {
  const { error } = await requireStaff(req)
  if (error) return error
  try {
    const p = await req.json().catch(() => null)
    const id = int(p?.id)
    if (id == null) return json({ error: 'id は必須です' }, 400)
    const { data, error: err } = await getAdminClient()
      .from('meter_master_history')
      .update({ reason: text(p.reason, 500) })
      .eq('id', id)
      .select('id, reason')
      .maybeSingle()
    if (err) throw new Error(err.message)
    if (!data) return json({ error: '変更履歴が見つかりません' }, 404)
    return json({ item: data })
  } catch (err) {
    console.error('meter-history-reason 失敗:', err)
    return json({ error: '変更理由の保存に失敗しました' }, 500)
  }
}

// 履歴の日時（JST の YYYY/MM/DD HH:mm）
function formatHistoryAt(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString()
  return `${d.slice(0, 10).replaceAll('-', '/')} ${d.slice(11, 16)}`
}

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export async function handleMeterHistoryRevert(req) {
  const { auth, error } = await requireStaff(req)
  if (error) return error
  try {
    const p = await req.json().catch(() => null)
    const id = int(p?.id)
    if (id == null) return json({ error: 'id は必須です' }, 400)
    const supabase = getAdminClient()
    const { data: h, error: hErr } = await supabase.from('meter_master_history').select('*').eq('id', id).maybeSingle()
    if (hErr) throw new Error(hErr.message)
    if (!h) return json({ error: '変更履歴が見つかりません' }, 404)
    if (h.op !== 'update') return json({ error: '追加・削除の記録は取り消せません（修正の記録だけ取り消せます）' }, 400)
    const def = HISTORY_TABLES[h.table_name]
    if (!def) return json({ error: '取り消せない記録です' }, 400)
    const fields = (h.changed_fields || []).filter((f) => !HISTORY_FIXED.has(f))
    if (fields.length === 0) return json({ error: '戻す項目がありません' }, 400)

    const keyValue = def.key === 'unit_no' ? Number(h.row_key) : h.row_key
    const { data: current, error: cErr } = await supabase.from(h.table_name).select('*').eq(def.key, keyValue).maybeSingle()
    if (cErr) throw new Error(cErr.message)
    if (!current) return json({ error: '対象がもうありません' }, 404)
    const changedSince = fields.filter((f) => !sameValue(current[f], h.new_row?.[f]))
    if (changedSince.length && p.force !== true) return json({ error: 'この変更のあとでさらに変わっています', changedSince }, 409)

    const since = reasonSince()
    const patch = { updated_by: `${actorOf(auth)}（取り消し）` }
    for (const f of fields) patch[f] = h.old_row?.[f] ?? null
    const { error: uErr } = await supabase.from(h.table_name).update(patch).eq(def.key, keyValue)
    if (uErr) {
      if (uErr.code === '23505') return json({ error: '戻すと番号・コードがほかと重なるため取り消せません' }, 409)
      throw new Error(uErr.message)
    }
    if (h.table_name === 'meters') await recomputeOaRatios(supabase)
    if (h.table_name === 'equipment_tenants') await applyTenantMoveOuts(supabase)
    const reason = text(p.reason, 500)
    await attachChangeReason(supabase, h.table_name, h.row_key, reason ? `${reason}（${formatHistoryAt(h.changed_at)} の変更の取り消し）` : `${formatHistoryAt(h.changed_at)} の変更の取り消し`, since)
    return json({ ok: true })
  } catch (err) {
    console.error('meter-history-revert 失敗:', err)
    return json({ error: '取り消しに失敗しました' }, 500)
  }
}
