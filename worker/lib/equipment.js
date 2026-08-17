// 備品管理機能の API ハンドラ（2026-08-12〜）。
// 蛍光ランプ等の入出庫・在庫管理。現行 FileMaker「備品管理」アプリの移行。
// 権限: staff/admin は読み書き、owner は GET のみ（他画面と同じ方針。docs/equipment-plan.md 9章）。
// テナント設置（reason='tenant'）・新規入替（reason='replace'）・署名は対応済み（2026-08-12 追加）。
// テナントは FileMaker からの同期（Phase 4・7-1）が入るまでは手動投入のみ。

import { json, verifyRequestAuth, canWrite } from './http.js'
import { getAdminClient } from './supabase-admin.js'
import { putObject, getObject, deleteObject } from './storage.js'

const ITEM_COLUMNS =
  'id, item_no, category_code, name, product_code, sort_order, warn_qty, warned_at, disabled, track_stock, note, created_at, updated_at'
const CATEGORY_COLUMNS = 'code, name, sort_order, note, created_at, updated_at'
const TENANT_COLUMNS = 'id, billing_code, name, short_name, floor, moved_out, default_item_id, note, synced_at'
const TXN_COLUMNS =
  'id, txn_no, item_id, kind, reason, occurred_at, quantity, supplier, tenant_id, tenant_code, tenant_name, ' +
  'tenant_short_name, floor, location, staff_name, signature_key, signed_at, note, created_by, updated_by, created_at, updated_at'

const VALID_KINDS = new Set(['in', 'out'])
const REASONS_BY_KIND = {
  in: new Set(['procure', 'deferred', 'adjust']),
  out: new Set(['tenant', 'common', 'replace', 'discard']),
}
// 画面から送信できる理由（2026-08-12、tenant=テナント設置・replace=新規入替を解禁）
const SUPPORTED_REASONS = new Set(['procure', 'deferred', 'adjust', 'common', 'discard', 'tenant', 'replace'])

function trimOrNull(value, max = 500) {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t ? t.slice(0, max) : null
}

// 認証と書き込み権限をまとめて確認する（reports.js と同じ形）
async function requireAuth(req, { write = false } = {}) {
  const auth = await verifyRequestAuth(req)
  if (!auth) return { error: json({ error: '認証が必要です' }, 401) }
  if (write && !canWrite(auth)) {
    return { error: json({ error: 'この操作を行う権限がありません' }, 403) }
  }
  return { auth }
}

// ============================================================
// カテゴリ
// ============================================================

// GET /api/equipment/categories — 一覧（表示順）
export async function handleEquipmentCategoryList(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('equipment_categories')
      .select(CATEGORY_COLUMNS)
      .order('sort_order', { ascending: true })
      .order('code', { ascending: true })
    if (err) {
      console.error('equipment-category-list:', err.message)
      return json({ error: 'カテゴリの取得に失敗しました' }, 500)
    }
    return json({ categories: data || [] })
  } catch (err) {
    console.error('equipment-category-list 失敗:', err)
    return json({ error: 'カテゴリの取得に失敗しました' }, 500)
  }
}

// PUT /api/equipment/categories — 追加・変更をまとめて upsert する（code が突合キー）。
// 件数が7件程度と少なく、削除は運用上ほぼ発生しない想定のため、この口では削除は行わない
// （備品マスタから参照されている可能性があり、丸ごと消し直すと外部キー制約に抵触するため）。
export async function handleEquipmentCategorySave(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const rows = Array.isArray(payload?.categories) ? payload.categories : null
    if (!rows) return json({ error: 'categories は配列で指定してください' }, 400)
    if (rows.length > 100) return json({ error: 'カテゴリが多すぎます' }, 400)

    const upserts = []
    for (const r of rows) {
      const code = trimOrNull(r?.code, 20)
      const name = trimOrNull(r?.name, 100)
      if (!code || !name) return json({ error: 'code と name は必須です' }, 400)
      upserts.push({
        code,
        name,
        sort_order: Number.isFinite(Number(r?.sort_order)) ? Number(r.sort_order) : 99,
        note: trimOrNull(r?.note, 500),
      })
    }
    if (upserts.length === 0) return json({ error: '保存するカテゴリがありません' }, 400)

    const supabase = getAdminClient()
    const { error: err } = await supabase.from('equipment_categories').upsert(upserts, { onConflict: 'code' })
    if (err) {
      console.error('equipment-category-save:', err.message)
      return json({ error: 'カテゴリの保存に失敗しました' }, 500)
    }
    return json({ ok: true })
  } catch (err) {
    console.error('equipment-category-save 失敗:', err)
    return json({ error: 'カテゴリの保存に失敗しました' }, 500)
  }
}

// ============================================================
// 備品マスタ・在庫
// ============================================================

// GET /api/equipment/items?include_disabled=1 — 備品マスタ＋現在庫＋当年の年計。
// 件数が数十件と少ないため、在庫（ビュー）・年計（ビュー）を別クエリで取り JS 側で結合する。
export async function handleEquipmentItemList(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const includeDisabled = new URL(req.url).searchParams.get('include_disabled') === '1'
    const supabase = getAdminClient()

    let itemsQuery = supabase.from('equipment_items').select(ITEM_COLUMNS)
    if (!includeDisabled) itemsQuery = itemsQuery.eq('disabled', false)
    const [{ data: items, error: itemsErr }, { data: categories, error: catErr }, { data: stock, error: stockErr }] =
      await Promise.all([
        itemsQuery,
        supabase.from('equipment_categories').select(CATEGORY_COLUMNS),
        supabase.from('equipment_stock').select('item_id, stock_qty, last_moved_at'),
      ])
    if (itemsErr || catErr || stockErr) {
      console.error('equipment-item-list:', itemsErr?.message || catErr?.message || stockErr?.message)
      return json({ error: '備品マスタの取得に失敗しました' }, 500)
    }

    const currentYear = Number(
      new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo', year: 'numeric' })
    )
    const { data: yearly, error: yearlyErr } = await supabase
      .from('equipment_yearly_totals')
      .select('item_id, in_qty, out_qty')
      .eq('year', currentYear)
    if (yearlyErr) {
      console.error('equipment-item-list(yearly):', yearlyErr.message)
      return json({ error: '備品マスタの取得に失敗しました' }, 500)
    }

    const catMap = new Map((categories || []).map((c) => [c.code, c]))
    const stockMap = new Map((stock || []).map((s) => [s.item_id, s]))
    const yearMap = new Map((yearly || []).map((y) => [y.item_id, y]))

    const merged = (items || []).map((item) => {
      const cat = catMap.get(item.category_code)
      const st = stockMap.get(item.id)
      const yr = yearMap.get(item.id)
      return {
        ...item,
        category_name: cat?.name || null,
        category_sort_order: cat?.sort_order ?? 99,
        stock_qty: item.track_stock ? st?.stock_qty ?? 0 : null,
        last_moved_at: st?.last_moved_at ?? null,
        year_in_qty: yr?.in_qty ?? 0,
        year_out_qty: yr?.out_qty ?? 0,
      }
    })
    merged.sort((a, b) => {
      if (a.category_sort_order !== b.category_sort_order) return a.category_sort_order - b.category_sort_order
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
      return a.item_no - b.item_no
    })

    return json({ items: merged })
  } catch (err) {
    console.error('equipment-item-list 失敗:', err)
    return json({ error: '備品マスタの取得に失敗しました' }, 500)
  }
}

// 次の item_no（欠番があっても最大値+1でよい。FileMaker由来の番号は移行時にそのまま入れる）
async function nextItemNo(supabase) {
  const { data } = await supabase
    .from('equipment_items')
    .select('item_no')
    .order('item_no', { ascending: false })
    .limit(1)
  return (data?.[0]?.item_no ?? 0) + 1
}

// POST /api/equipment/items — 備品の新規登録
export async function handleEquipmentItemCreate(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const name = trimOrNull(payload?.name, 200)
    if (!name) return json({ error: '備品名は必須です' }, 400)

    const supabase = getAdminClient()
    const itemNo = Number.isInteger(payload?.item_no) ? payload.item_no : await nextItemNo(supabase)

    const row = {
      item_no: itemNo,
      category_code: trimOrNull(payload?.category_code, 20),
      name,
      product_code: trimOrNull(payload?.product_code, 100),
      sort_order: Number.isFinite(Number(payload?.sort_order)) ? Number(payload.sort_order) : 99,
      warn_qty: payload?.warn_qty === '' || payload?.warn_qty == null ? null : Number(payload.warn_qty),
      disabled: Boolean(payload?.disabled),
      track_stock: payload?.track_stock === false ? false : true,
      note: trimOrNull(payload?.note, 1000),
    }
    const { data, error: err } = await supabase.from('equipment_items').insert(row).select(ITEM_COLUMNS).single()
    if (err) {
      console.error('equipment-item-create:', err.message)
      const msg = err.code === '23505' ? '備品IDが重複しています' : '備品の登録に失敗しました'
      return json({ error: msg }, err.code === '23505' ? 409 : 500)
    }
    return json({ item: data })
  } catch (err) {
    console.error('equipment-item-create 失敗:', err)
    return json({ error: '備品の登録に失敗しました' }, 500)
  }
}

// PATCH /api/equipment/items — 備品の更新
export async function handleEquipmentItemUpdate(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const id = typeof payload?.id === 'string' ? payload.id : ''
    if (!id) return json({ error: 'id は必須です' }, 400)

    const patch = {}
    if ('name' in payload) {
      const name = trimOrNull(payload.name, 200)
      if (!name) return json({ error: '備品名は必須です' }, 400)
      patch.name = name
    }
    if ('category_code' in payload) patch.category_code = trimOrNull(payload.category_code, 20)
    if ('product_code' in payload) patch.product_code = trimOrNull(payload.product_code, 100)
    if ('sort_order' in payload) patch.sort_order = Number(payload.sort_order) || 99
    if ('warn_qty' in payload) {
      patch.warn_qty = payload.warn_qty === '' || payload.warn_qty == null ? null : Number(payload.warn_qty)
    }
    if ('disabled' in payload) patch.disabled = Boolean(payload.disabled)
    if ('track_stock' in payload) patch.track_stock = Boolean(payload.track_stock)
    if ('note' in payload) patch.note = trimOrNull(payload.note, 1000)
    if (Object.keys(patch).length === 0) return json({ error: '更新する項目がありません' }, 400)

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('equipment_items')
      .update(patch)
      .eq('id', id)
      .select(ITEM_COLUMNS)
      .maybeSingle()
    if (err) {
      console.error('equipment-item-update:', err.message)
      return json({ error: '備品の更新に失敗しました' }, 500)
    }
    if (!data) return json({ error: '備品が見つかりません' }, 404)
    return json({ item: data })
  } catch (err) {
    console.error('equipment-item-update 失敗:', err)
    return json({ error: '備品の更新に失敗しました' }, 500)
  }
}

// DELETE /api/equipment/items?id=… — 入出庫が1件でもあれば削除不可（disabled を促す）
export async function handleEquipmentItemDelete(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!id) return json({ error: 'id は必須です' }, 400)

    const supabase = getAdminClient()
    const { count, error: cntErr } = await supabase
      .from('equipment_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('item_id', id)
    if (cntErr) {
      console.error('equipment-item-delete(count):', cntErr.message)
      return json({ error: '備品の削除に失敗しました' }, 500)
    }
    if ((count || 0) > 0) {
      return json({ error: '入出庫の記録がある備品は削除できません。無効化してください' }, 400)
    }
    const { error: err } = await supabase.from('equipment_items').delete().eq('id', id)
    if (err) {
      console.error('equipment-item-delete:', err.message)
      return json({ error: '備品の削除に失敗しました' }, 500)
    }
    return json({ ok: true })
  } catch (err) {
    console.error('equipment-item-delete 失敗:', err)
    return json({ error: '備品の削除に失敗しました' }, 500)
  }
}

// ============================================================
// 入出庫
// ============================================================

// period（3m/1y/all）から絞り込みの起点日時を返す。null なら絞り込みなし（全期間）
function periodCutoff(period) {
  if (period === '3m') {
    const d = new Date()
    d.setMonth(d.getMonth() - 3)
    return d
  }
  if (period === '1y') {
    const d = new Date()
    d.setFullYear(d.getFullYear() - 1)
    return d
  }
  return null
}

// GET /api/equipment/transactions?period=3m|1y|all — 全備品分の入出庫明細を備品ごとにまとめて返す
// （在庫一覧の各行に明細をその場で展開表示するため。2026-08-12〜。item_no を省略した場合はこちら）。
// 残高は各備品の全履歴を古い順に積み上げてから期間で絞り込む（期間フィルタで残高がずれないため）。
async function handleEquipmentTransactionListAll(req, period) {
  try {
    const supabase = getAdminClient()
    const { data: rows, error: txnErr } = await supabase
      .from('equipment_transactions')
      .select(TXN_COLUMNS)
      .order('occurred_at', { ascending: true })
      .order('created_at', { ascending: true })
    if (txnErr) {
      console.error('equipment-txn-list-all:', txnErr.message)
      return json({ error: '入出庫の取得に失敗しました' }, 500)
    }

    const byItem = new Map()
    for (const r of rows || []) {
      if (!byItem.has(r.item_id)) byItem.set(r.item_id, [])
      byItem.get(r.item_id).push(r)
    }

    const cutoff = periodCutoff(period)
    const transactionsByItem = {}
    for (const [itemId, list] of byItem) {
      let balance = 0
      const withBalance = list.map((r) => {
        balance += r.kind === 'in' ? r.quantity : -r.quantity
        return { ...r, balance }
      })
      const filtered = cutoff ? withBalance.filter((r) => new Date(r.occurred_at) >= cutoff) : withBalance
      filtered.reverse()
      transactionsByItem[itemId] = filtered
    }
    return json({ transactionsByItem })
  } catch (err) {
    console.error('equipment-txn-list-all 失敗:', err)
    return json({ error: '入出庫の取得に失敗しました' }, 500)
  }
}

// GET /api/equipment/transactions?item_no=…&period=3m|1y|all — 指定した備品の入出庫明細。
// 残高（その時点の在庫）は対象備品の全履歴を古い順に積み上げて計算してから、
// 表示期間で絞り込む（期間フィルタで残高がずれないようにするため）。
export async function handleEquipmentTransactionList(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const params = new URL(req.url).searchParams
    const itemNo = params.get('item_no')
    const period = params.get('period') || '3m'
    if (!itemNo) return handleEquipmentTransactionListAll(req, period)
    if (!/^\d+$/.test(itemNo)) return json({ error: 'item_no が不正です' }, 400)

    const supabase = getAdminClient()
    const { data: item, error: itemErr } = await supabase
      .from('equipment_items')
      .select(ITEM_COLUMNS)
      .eq('item_no', Number(itemNo))
      .maybeSingle()
    if (itemErr) {
      console.error('equipment-txn-list(item):', itemErr.message)
      return json({ error: '入出庫の取得に失敗しました' }, 500)
    }
    if (!item) return json({ error: '備品が見つかりません' }, 404)

    const { data: rows, error: txnErr } = await supabase
      .from('equipment_transactions')
      .select(TXN_COLUMNS)
      .eq('item_id', item.id)
      .order('occurred_at', { ascending: true })
      .order('created_at', { ascending: true })
    if (txnErr) {
      console.error('equipment-txn-list:', txnErr.message)
      return json({ error: '入出庫の取得に失敗しました' }, 500)
    }

    const currentYear = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo', year: 'numeric' }))
    let balance = 0
    let yearIn = 0
    let yearOut = 0
    const withBalance = (rows || []).map((r) => {
      balance += r.kind === 'in' ? r.quantity : -r.quantity
      const y = Number(new Date(r.occurred_at).toLocaleString('en-US', { timeZone: 'Asia/Tokyo', year: 'numeric' }))
      if (y === currentYear) {
        if (r.kind === 'in') yearIn += r.quantity
        else yearOut += r.quantity
      }
      return { ...r, balance }
    })
    // 全履歴を積み上げた最終値＝現在庫（equipment_stock ビューと同じ計算を再利用できる）
    const itemWithStock = { ...item, stock_qty: item.track_stock ? balance : null, year_in_qty: yearIn, year_out_qty: yearOut }

    const cutoff = periodCutoff(period)
    const filtered = cutoff ? withBalance.filter((r) => new Date(r.occurred_at) >= cutoff) : withBalance
    filtered.reverse() // 新しい順で返す（一覧の表示順）

    return json({ item: itemWithStock, transactions: filtered })
  } catch (err) {
    console.error('equipment-txn-list 失敗:', err)
    return json({ error: '入出庫の取得に失敗しました' }, 500)
  }
}

// reason に応じて許可される付随フィールドを検証する（3-4: テナント欄＝請求先。
// DB の CHECK 制約ではなくアプリ層で強制する。docs/equipment-plan.md 4-1・8-4(1)(2)）
function validateTenantFields(reason, payload) {
  const hasTenantFields = Boolean(
    payload?.tenant_id || trimOrNull(payload?.tenant_code, 20) || trimOrNull(payload?.tenant_name, 200)
  )
  if (reason !== 'tenant' && hasTenantFields) {
    return 'テナント設置（tenant）以外では請求先（テナント）情報を持てません'
  }
  return null
}

// POST /api/equipment/transactions — 入出庫の登録
export async function handleEquipmentTransactionCreate(req) {
  const { auth, error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    if (!payload || typeof payload !== 'object') return json({ error: 'JSON ボディが必要です' }, 400)

    const itemId = typeof payload.item_id === 'string' ? payload.item_id : ''
    if (!itemId) return json({ error: 'item_id は必須です' }, 400)
    const kind = payload.kind
    if (!VALID_KINDS.has(kind)) return json({ error: 'kind が不正です' }, 400)
    const reason = payload.reason
    if (!REASONS_BY_KIND[kind]?.has(reason)) return json({ error: 'reason が不正です' }, 400)
    if (!SUPPORTED_REASONS.has(reason)) {
      return json({ error: 'この入出庫理由はまだ利用できません（Phase 2 で対応予定）' }, 400)
    }
    const quantity = Number(payload.quantity)
    if (!Number.isFinite(quantity) || quantity === 0) return json({ error: 'quantity が不正です' }, 400)
    if (quantity < 0 && reason !== 'adjust') {
      return json({ error: 'マイナスの数量は在庫調整のときだけ指定できます' }, 400)
    }
    const occurredAt =
      payload.occurred_at && !Number.isNaN(Date.parse(payload.occurred_at))
        ? new Date(payload.occurred_at).toISOString()
        : new Date().toISOString()

    const tenantErr = validateTenantFields(reason, payload)
    if (tenantErr) return json({ error: tenantErr }, 400)

    const supabase = getAdminClient()

    // テナント設置は請求先そのものなので、名称・コードはクライアントの送信値を
    // 信用せず、必ずサーバー側で equipment_tenants を引いて確定する（3-4・4-1）
    let tenantFields = { tenant_id: null, tenant_code: null, tenant_name: null, tenant_short_name: null }
    let tenantFloor = trimOrNull(payload.floor, 20)
    if (reason === 'tenant') {
      const tenantId = typeof payload.tenant_id === 'string' ? payload.tenant_id : ''
      if (!tenantId) return json({ error: 'テナント設置には設置先テナントの指定が必要です' }, 400)
      const { data: tenant, error: tenantErr2 } = await supabase
        .from('equipment_tenants')
        .select('id, billing_code, name, short_name, floor')
        .eq('id', tenantId)
        .maybeSingle()
      if (tenantErr2) {
        console.error('equipment-txn-create(tenant):', tenantErr2.message)
        return json({ error: '入出庫の登録に失敗しました' }, 500)
      }
      if (!tenant) return json({ error: '指定されたテナントが見つかりません' }, 404)
      tenantFields = {
        tenant_id: tenant.id,
        tenant_code: tenant.billing_code,
        tenant_name: tenant.name,
        tenant_short_name: tenant.short_name,
      }
      tenantFloor = tenant.floor
    }

    const row = {
      item_id: itemId,
      kind,
      reason,
      occurred_at: occurredAt,
      quantity,
      supplier: trimOrNull(payload.supplier, 200),
      ...tenantFields,
      floor: tenantFloor,
      location: reason === 'tenant' ? null : trimOrNull(payload.location, 200),
      staff_name: trimOrNull(payload.staff_name, 200),
      note: trimOrNull(payload.note, 1000),
      created_by: auth.sub,
      updated_by: auth.sub,
    }

    const { data, error: err } = await supabase.from('equipment_transactions').insert(row).select(TXN_COLUMNS).single()
    if (err) {
      console.error('equipment-txn-create:', err.message)
      return json({ error: '入出庫の登録に失敗しました' }, 500)
    }
    await refreshWarning(supabase, itemId)
    return json({ transaction: data })
  } catch (err) {
    console.error('equipment-txn-create 失敗:', err)
    return json({ error: '入出庫の登録に失敗しました' }, 500)
  }
}

// PATCH /api/equipment/transactions — 入出庫の修正
export async function handleEquipmentTransactionUpdate(req) {
  const { auth, error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const id = typeof payload?.id === 'string' ? payload.id : ''
    if (!id) return json({ error: 'id は必須です' }, 400)

    const supabase = getAdminClient()
    const { data: existing, error: existErr } = await supabase
      .from('equipment_transactions')
      .select('id, item_id, kind, reason, signed_at, tenant_id')
      .eq('id', id)
      .maybeSingle()
    if (existErr) {
      console.error('equipment-txn-update(load):', existErr.message)
      return json({ error: '入出庫の更新に失敗しました' }, 500)
    }
    if (!existing) return json({ error: '対象が見つかりません' }, 404)
    // 署名済みの記録は staff は修正不可（9章。将来 Phase 2 で署名が付くと発生する）
    if (existing.signed_at && auth.role !== 'admin') {
      return json({ error: '署名済みの記録は修正できません' }, 403)
    }

    const reason = 'reason' in payload ? payload.reason : existing.reason
    if (!REASONS_BY_KIND[existing.kind]?.has(reason)) return json({ error: 'reason が不正です' }, 400)
    if (!SUPPORTED_REASONS.has(reason)) {
      return json({ error: 'この入出庫理由はまだ利用できません' }, 400)
    }
    const tenantErr = validateTenantFields(reason, payload)
    if (tenantErr) return json({ error: tenantErr }, 400)

    const patch = { updated_by: auth.sub }
    if ('reason' in payload) patch.reason = reason
    if ('occurred_at' in payload) {
      if (Number.isNaN(Date.parse(payload.occurred_at))) return json({ error: 'occurred_at が不正です' }, 400)
      patch.occurred_at = new Date(payload.occurred_at).toISOString()
    }
    if ('quantity' in payload) {
      const quantity = Number(payload.quantity)
      if (!Number.isFinite(quantity) || quantity === 0) return json({ error: 'quantity が不正です' }, 400)
      if (quantity < 0 && reason !== 'adjust') {
        return json({ error: 'マイナスの数量は在庫調整のときだけ指定できます' }, 400)
      }
      patch.quantity = quantity
    }
    if ('supplier' in payload) patch.supplier = trimOrNull(payload.supplier, 200)

    // テナント設置は、選び直された（tenant_id が渡された）場合のみサーバー側で再解決する。
    // それ以外（reason を tenant のまま維持しただけ）は既存の tenant_id・floor 等を保つ
    if (reason === 'tenant') {
      const tenantId = typeof payload.tenant_id === 'string' ? payload.tenant_id : existing.tenant_id
      if (!tenantId) return json({ error: 'テナント設置には設置先テナントの指定が必要です' }, 400)
      if ('tenant_id' in payload) {
        const { data: tenant, error: tenantErr2 } = await supabase
          .from('equipment_tenants')
          .select('id, billing_code, name, short_name, floor')
          .eq('id', tenantId)
          .maybeSingle()
        if (tenantErr2) {
          console.error('equipment-txn-update(tenant):', tenantErr2.message)
          return json({ error: '入出庫の更新に失敗しました' }, 500)
        }
        if (!tenant) return json({ error: '指定されたテナントが見つかりません' }, 404)
        patch.tenant_id = tenant.id
        patch.tenant_code = tenant.billing_code
        patch.tenant_name = tenant.name
        patch.tenant_short_name = tenant.short_name
        patch.floor = tenant.floor
        patch.location = null
      }
    } else {
      if ('floor' in payload) patch.floor = trimOrNull(payload.floor, 20)
      if ('location' in payload) patch.location = trimOrNull(payload.location, 200)
    }
    if ('staff_name' in payload) patch.staff_name = trimOrNull(payload.staff_name, 200)
    if ('note' in payload) patch.note = trimOrNull(payload.note, 1000)

    const { data, error: err } = await supabase
      .from('equipment_transactions')
      .update(patch)
      .eq('id', id)
      .select(TXN_COLUMNS)
      .maybeSingle()
    if (err) {
      console.error('equipment-txn-update:', err.message)
      return json({ error: '入出庫の更新に失敗しました' }, 500)
    }
    await refreshWarning(supabase, existing.item_id)
    return json({ transaction: data })
  } catch (err) {
    console.error('equipment-txn-update 失敗:', err)
    return json({ error: '入出庫の更新に失敗しました' }, 500)
  }
}

// DELETE /api/equipment/transactions?id=…
export async function handleEquipmentTransactionDelete(req) {
  const { auth, error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!id) return json({ error: 'id は必須です' }, 400)

    const supabase = getAdminClient()
    const { data: existing } = await supabase
      .from('equipment_transactions')
      .select('item_id, signed_at, signature_key')
      .eq('id', id)
      .maybeSingle()
    if (existing?.signed_at && auth.role !== 'admin') {
      return json({ error: '署名済みの記録は削除できません' }, 403)
    }

    const { error: err } = await supabase.from('equipment_transactions').delete().eq('id', id)
    if (err) {
      console.error('equipment-txn-delete:', err.message)
      return json({ error: '入出庫の削除に失敗しました' }, 500)
    }
    if (existing?.signature_key) await deleteObject(existing.signature_key)
    if (existing?.item_id) await refreshWarning(supabase, existing.item_id)
    return json({ ok: true })
  } catch (err) {
    console.error('equipment-txn-delete 失敗:', err)
    return json({ error: '入出庫の削除に失敗しました' }, 500)
  }
}

// 在庫が warn_qty 以下になったかどうかを見て warned_at を更新する（Web Push 通知は Phase 3 で実装。
// ここでは「下回っていない→下回った」の遷移を検知するための状態管理だけ先に用意しておく）。
async function refreshWarning(supabase, itemId) {
  try {
    const { data: item } = await supabase
      .from('equipment_items')
      .select('id, warn_qty, warned_at, track_stock')
      .eq('id', itemId)
      .maybeSingle()
    if (!item || !item.track_stock || item.warn_qty == null) return
    const { data: stock } = await supabase.from('equipment_stock').select('stock_qty').eq('item_id', itemId).maybeSingle()
    const qty = stock?.stock_qty ?? 0
    if (qty <= item.warn_qty && !item.warned_at) {
      await supabase.from('equipment_items').update({ warned_at: new Date().toISOString() }).eq('id', itemId)
    } else if (qty > item.warn_qty && item.warned_at) {
      await supabase.from('equipment_items').update({ warned_at: null }).eq('id', itemId)
    }
  } catch (err) {
    // 通知状態の更新に失敗しても入出庫の登録自体は成功させる
    console.error('equipment refreshWarning 失敗:', err)
  }
}

// ============================================================
// 担当者・場所・調達先の候補（過去値からの重複除去）
// ============================================================

const SUGGEST_FIELDS = { staff: 'staff_name', location: 'location', supplier: 'supplier' }

// GET /api/equipment/suggest?field=staff|location|supplier — <datalist> 用の候補（使用頻度順）
export async function handleEquipmentSuggest(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const field = SUGGEST_FIELDS[new URL(req.url).searchParams.get('field')]
    if (!field) return json({ error: 'field が不正です' }, 400)

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('equipment_transactions')
      .select(field)
      .not(field, 'is', null)
      .order('occurred_at', { ascending: false })
      .limit(500)
    if (err) {
      console.error('equipment-suggest:', err.message)
      return json({ error: '候補の取得に失敗しました' }, 500)
    }
    const seen = new Map() // 値 → 初出順（新しい順のまま最初に出てきた位置を維持）
    for (const r of data || []) {
      const v = r[field]
      if (v && !seen.has(v)) seen.set(v, seen.size)
    }
    return json({ values: [...seen.keys()].slice(0, 50) })
  } catch (err) {
    console.error('equipment-suggest 失敗:', err)
    return json({ error: '候補の取得に失敗しました' }, 500)
  }
}

// ============================================================
// テナント
// ============================================================

// GET /api/equipment/tenants?include_moved_out=1 — テナント一覧（階・名称順）。
// FileMaker との同期（Phase 4・7-1）が入るまでは手動投入のデータを参照する
export async function handleEquipmentTenantList(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const includeMovedOut = new URL(req.url).searchParams.get('include_moved_out') === '1'
    const supabase = getAdminClient()
    let query = supabase.from('equipment_tenants').select(TENANT_COLUMNS)
    if (!includeMovedOut) query = query.eq('moved_out', false)
    const { data, error: err } = await query.order('floor', { ascending: true }).order('name', { ascending: true })
    if (err) {
      console.error('equipment-tenant-list:', err.message)
      return json({ error: 'テナント一覧の取得に失敗しました' }, 500)
    }
    return json({ tenants: data || [] })
  } catch (err) {
    console.error('equipment-tenant-list 失敗:', err)
    return json({ error: 'テナント一覧の取得に失敗しました' }, 500)
  }
}

// PATCH /api/equipment/tenants — default_item_id（当システム独自項目。FileMaker同期の対象外）の
// 設定、および billing_code 空欄テナントの手動修正（8-4(3)）用（2026-08-17）
export async function handleEquipmentTenantUpdate(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const id = typeof payload?.id === 'string' ? payload.id : ''
    if (!id) return json({ error: 'id は必須です' }, 400)

    const patch = {}
    if ('default_item_id' in payload) patch.default_item_id = payload.default_item_id || null
    if ('billing_code' in payload) patch.billing_code = trimOrNull(payload.billing_code, 20)
    if ('note' in payload) patch.note = trimOrNull(payload.note, 500)
    if (Object.keys(patch).length === 0) return json({ error: '更新する項目がありません' }, 400)

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('equipment_tenants')
      .update(patch)
      .eq('id', id)
      .select(TENANT_COLUMNS)
      .maybeSingle()
    if (err) {
      console.error('equipment-tenant-update:', err.message)
      const msg = err.code === '23505' ? '請求先コードが重複しています' : 'テナントの更新に失敗しました'
      return json({ error: msg }, err.code === '23505' ? 409 : 500)
    }
    if (!data) return json({ error: 'テナントが見つかりません' }, 404)
    return json({ tenant: data })
  } catch (err) {
    console.error('equipment-tenant-update 失敗:', err)
    return json({ error: 'テナントの更新に失敗しました' }, 500)
  }
}

// ============================================================
// FileMaker 連携（APIキー認証。JWTではなく機械間連携専用のキー。2026-08-17。
// docs/equipment-plan.md 6-2・6-3 参照）
// ============================================================

// タイミング攻撃を避けるため、長さの不一致でも早期returnせず全バイトをXORし続けて比較する
function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return diff === 0
}

// X-API-Key ヘッダを Worker シークレットと照合する。IP許可リスト（EQUIPMENT_API_ALLOW_IPS。
// カンマ区切り）が設定されていれば併せて検証する。シークレット自体が未設定なら常に拒否する
// （fail closed。未発行の段階でエンドポイントが無防備に開くことを避ける）
function verifyEquipmentApiKey(req, secretEnvName) {
  const expected = process.env[secretEnvName]
  if (!expected) return false
  const provided = req.headers.get('x-api-key') || ''
  if (!timingSafeEqualString(provided, expected)) return false

  const allowList = (process.env.EQUIPMENT_API_ALLOW_IPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (allowList.length > 0) {
    const ip = req.headers.get('cf-connecting-ip') || ''
    if (!allowList.includes(ip)) return false
  }
  return true
}

// KV でのレート制限（ログイン試行回数と同じ LOGIN_ATTEMPTS を流用）。
// binding が無い環境（ローカル開発等）では制限をスキップする
async function checkEquipmentApiRateLimit(env, key, limit, windowSeconds) {
  const kv = env?.LOGIN_ATTEMPTS || null
  if (!kv) return true
  const count = Number(await kv.get(key)) || 0
  if (count >= limit) return false
  await kv.put(key, String(count + 1), { expirationTtl: windowSeconds })
  return true
}

const EQUIPMENT_API_RATE_LIMIT = 60 // 同一IPからの1時間あたり上限（6-2/6-3共通）

// 呼び出しを processing ログへ記録する（活動ログ画面から辿れるように。既存の log_type
// 制約 fetch/status_change はそのままに、status_change として actor で識別する）
async function logEquipmentApiCall(supabase, message) {
  try {
    await supabase
      .from('activity_logs')
      .insert({ log_type: 'status_change', actor: 'FileMaker連携', message })
  } catch (err) {
    console.error('logEquipmentApiCall 失敗:', err)
  }
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

// JST の指定月（'YYYY-MM'）の月初・翌月初を UTC の Date で返す
function jstMonthRangeUtc(month) {
  const [y, m] = month.split('-').map(Number)
  const JST_OFFSET_MS = 9 * 3600 * 1000
  return {
    start: new Date(Date.UTC(y, m - 1, 1) - JST_OFFSET_MS),
    end: new Date(Date.UTC(y, m, 1) - JST_OFFSET_MS),
  }
}

// GET /api/equipment/installations?month=YYYY-MM&scope=tenant|common|all&tenant_code=…
// FileMaker 向けの公開API（6-2。APIキー認証）。「テナントに設置したランプ情報を年月指定で取得」への回答。
// 請求の元データになるため、reason は scope で明示的に絞り、replace（新規入替）・discard（不良品処分）は
// どの scope でも返さない（3-4。新規入替は請求対象外であり、混ぜると誤請求のもとになる）。
export async function handleEquipmentInstallations(req, env) {
  if (!verifyEquipmentApiKey(req, 'EQUIPMENT_API_KEY')) {
    return json({ error: '認証に失敗しました' }, 401)
  }
  const ip = req.headers.get('cf-connecting-ip') || 'unknown'
  if (!(await checkEquipmentApiRateLimit(env, `eq-installations:${ip}`, EQUIPMENT_API_RATE_LIMIT, 3600))) {
    return json({ error: 'リクエストが多すぎます。しばらくしてから再度お試しください' }, 429)
  }
  try {
    const params = new URL(req.url).searchParams
    const month = params.get('month') || ''
    if (!MONTH_PATTERN.test(month)) return json({ error: 'month は YYYY-MM 形式で指定してください' }, 400)
    const scope = params.get('scope') || 'tenant'
    if (!['tenant', 'common', 'all'].includes(scope)) return json({ error: 'scope が不正です' }, 400)
    const tenantCode = trimOrNull(params.get('tenant_code'), 20)
    const reasons = scope === 'all' ? ['tenant', 'common'] : [scope]
    const { start, end } = jstMonthRangeUtc(month)

    const supabase = getAdminClient()
    let query = supabase
      .from('equipment_transactions')
      .select('txn_no, occurred_at, tenant_code, tenant_name, floor, quantity, staff_name, signed_at, note, item_id, reason')
      .eq('kind', 'out')
      .in('reason', reasons)
      .gte('occurred_at', start.toISOString())
      .lt('occurred_at', end.toISOString())
      .order('occurred_at', { ascending: true })
    if (tenantCode) query = query.eq('tenant_code', tenantCode)
    const { data: rows, error: txnErr } = await query
    if (txnErr) {
      console.error('equipment-installations:', txnErr.message)
      return json({ error: '取得に失敗しました' }, 500)
    }

    const { data: items, error: itemsErr } = await supabase.from('equipment_items').select('id, item_no, name, product_code')
    if (itemsErr) {
      console.error('equipment-installations(items):', itemsErr.message)
      return json({ error: '取得に失敗しました' }, 500)
    }
    const itemMap = new Map((items || []).map((i) => [i.id, i]))

    const installations = (rows || []).map((r) => {
      const item = itemMap.get(r.item_id)
      return {
        txn_no: r.txn_no,
        installed_at: r.occurred_at,
        tenant_code: r.tenant_code,
        tenant_name: r.tenant_name,
        floor: r.floor,
        item_no: item?.item_no ?? null,
        item_name: item?.name ?? null,
        product_code: item?.product_code ?? null,
        quantity: r.quantity,
        staff_name: r.staff_name,
        signed: Boolean(r.signed_at),
        note: r.note,
      }
    })

    // 請求連携用の月次集計（8-5-2。「修理データ」と同じ中身。請求対象＝テナント設置のみなので
    // scope に関わらずテナント設置分だけを集計する。呼び出し側が「実績月＝翌月請求」の変換を行う前提）
    const billingMap = new Map()
    for (const r of rows || []) {
      if (r.reason !== 'tenant') continue
      const item = itemMap.get(r.item_id)
      const key = `${r.tenant_code}:${item?.item_no}`
      if (!billingMap.has(key)) {
        billingMap.set(key, {
          tenant_code: r.tenant_code,
          tenant_name: r.tenant_name,
          item_no: item?.item_no ?? null,
          item_name: item?.name ?? null,
          quantity: 0,
          dates: [],
        })
      }
      const b = billingMap.get(key)
      b.quantity += r.quantity
      b.dates.push(r.occurred_at)
    }
    const billing = [...billingMap.values()].map((b) => ({ ...b, dates: b.dates.sort() }))

    await logEquipmentApiCall(supabase, `設置実績取得: month=${month} scope=${scope} 件数=${installations.length}`)

    return json({
      month,
      generated_at: new Date().toISOString(),
      count: installations.length,
      installations,
      billing,
    })
  } catch (err) {
    console.error('equipment-installations 失敗:', err)
    return json({ error: '取得に失敗しました' }, 500)
  }
}

// POST /api/equipment/tenants/sync — FileMaker からのテナント全件洗い替え（6-3。APIキー認証・書き込み専用）。
// 送られてきた「現在有効なテナント全件」で Update/Insert し、含まれなかった既存の filemaker 由来行は
// 論理削除（moved_out=true）する。空配列・極端な件数減少は事故防止のため拒否する（6-3の5）
export async function handleEquipmentTenantSync(req, env) {
  if (!verifyEquipmentApiKey(req, 'EQUIPMENT_TENANT_SYNC_API_KEY')) {
    return json({ error: '認証に失敗しました' }, 401)
  }
  const ip = req.headers.get('cf-connecting-ip') || 'unknown'
  if (!(await checkEquipmentApiRateLimit(env, `eq-tenant-sync:${ip}`, EQUIPMENT_API_RATE_LIMIT, 3600))) {
    return json({ error: 'リクエストが多すぎます。しばらくしてから再度お試しください' }, 429)
  }
  try {
    const payload = await req.json().catch(() => null)
    if (!Array.isArray(payload)) return json({ error: '配列で指定してください' }, 400)
    if (payload.length > 1000) return json({ error: 'テナント件数が多すぎます' }, 400)

    const rows = []
    for (const r of payload) {
      const billingCode = trimOrNull(r?.billing_code, 20)
      const name = trimOrNull(r?.name, 200)
      if (!billingCode || !name) return json({ error: 'billing_code と name はすべての要素で必須です' }, 400)
      rows.push({
        billing_code: billingCode,
        name,
        short_name: trimOrNull(r?.short_name, 100),
        floor: trimOrNull(r?.floor, 20),
        note: trimOrNull(r?.note, 500),
      })
    }

    // 安全ガード（6-3の5）その1: 空配列は問答無用で拒否する（全件が退去済み扱いになる事故を防ぐため）
    if (rows.length === 0) {
      return json({ error: '空の配列は受け付けられません（全件が退去済み扱いになる事故を防ぐため）' }, 400)
    }

    const supabase = getAdminClient()

    // 安全ガード（6-3の5）その2: 現在の有効件数から大きく減っていれば拒否する。
    // 全件洗い替え方式は「送られなかった＝退去」とみなす設計のため、不完全な配列を通すと
    // 有効なテナントを誤って一括で論理削除してしまう事故になりうる
    const { count: currentActive, error: countErr } = await supabase
      .from('equipment_tenants')
      .select('id', { count: 'exact', head: true })
      .eq('source', 'filemaker')
      .eq('moved_out', false)
    if (countErr) {
      console.error('equipment-tenant-sync(count):', countErr.message)
      return json({ error: '同期に失敗しました' }, 500)
    }
    if ((currentActive || 0) > 0 && rows.length < (currentActive || 0) * 0.5) {
      return json(
        {
          error: `件数が前回の有効件数（${currentActive}件）から大きく減っています（今回${rows.length}件）。念のため処理を中止しました`,
        },
        400
      )
    }

    const { data: existing, error: existErr } = await supabase
      .from('equipment_tenants')
      .select('id, billing_code')
      .eq('source', 'filemaker')
    if (existErr) {
      console.error('equipment-tenant-sync(load):', existErr.message)
      return json({ error: '同期に失敗しました' }, 500)
    }
    const existingCodes = new Set((existing || []).map((t) => t.billing_code))
    const incomingCodes = new Set(rows.map((r) => r.billing_code))

    const now = new Date().toISOString()
    const toUpsert = rows.map((r) => ({
      billing_code: r.billing_code,
      name: r.name,
      short_name: r.short_name,
      floor: r.floor,
      note: r.note,
      moved_out: false,
      source: 'filemaker',
      synced_at: now,
    }))
    // default_item_id は当システム独自項目のため、upsert 対象の列に含めない＝上書きされない
    const { error: upsertErr } = await supabase.from('equipment_tenants').upsert(toUpsert, { onConflict: 'billing_code' })
    if (upsertErr) {
      console.error('equipment-tenant-sync(upsert):', upsertErr.message)
      return json({ error: '同期に失敗しました' }, 500)
    }

    const toRetire = [...existingCodes].filter((code) => code && !incomingCodes.has(code))
    if (toRetire.length > 0) {
      const { error: retireErr } = await supabase
        .from('equipment_tenants')
        .update({ moved_out: true })
        .in('billing_code', toRetire)
      if (retireErr) {
        console.error('equipment-tenant-sync(retire):', retireErr.message)
        return json({ error: '同期に失敗しました' }, 500)
      }
    }

    const inserted = rows.filter((r) => !existingCodes.has(r.billing_code)).length
    const updated = rows.length - inserted

    await logEquipmentApiCall(
      supabase,
      `テナント同期受信: 受信${rows.length}件（新規${inserted}・更新${updated}・退去${toRetire.length}）`
    )

    return json({ ok: true, received: rows.length, inserted, updated, retired: toRetire.length })
  } catch (err) {
    console.error('equipment-tenant-sync 失敗:', err)
    return json({ error: '同期に失敗しました' }, 500)
  }
}

// ============================================================
// 署名（テナント設置のみ。5-5。記録の保存と同時、または後から足すのどちらも
// このエンドポイントで扱う＝「先に記録だけ保存→後日、署名だけ足す」運用の受け口を兼ねる）
// ============================================================

const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024 // 実際は長辺600px程度に縮小したPNGなので数十KB程度で収まる想定

// POST /api/equipment/signature（multipart: txn_id, file） — 署名の登録
export async function handleEquipmentSignatureUpload(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const form = await req.formData().catch(() => null)
    const txnId = String(form?.get('txn_id') || '')
    const file = form?.get('file')
    if (!txnId) return json({ error: 'txn_id は必須です' }, 400)
    if (!file || typeof file === 'string') return json({ error: 'file は必須です' }, 400)
    if (file.size > MAX_SIGNATURE_BYTES) return json({ error: '署名画像が大きすぎます' }, 413)
    if (file.type !== 'image/png') return json({ error: 'PNG形式のみ対応しています' }, 415)

    const supabase = getAdminClient()
    const { data: txn, error: loadErr } = await supabase
      .from('equipment_transactions')
      .select('id, reason, signed_at')
      .eq('id', txnId)
      .maybeSingle()
    if (loadErr) {
      console.error('equipment-signature-upload(load):', loadErr.message)
      return json({ error: '署名の登録に失敗しました' }, 500)
    }
    if (!txn) return json({ error: '対象が見つかりません' }, 404)
    if (txn.reason !== 'tenant') return json({ error: 'テナント設置以外には署名を登録できません' }, 400)
    if (txn.signed_at) return json({ error: 'この記録はすでに署名済みです' }, 400)

    const key = `equipment/signatures/${txnId}.png`
    await putObject(key, file.stream(), file.type, { upsert: true })

    const { data, error: err } = await supabase
      .from('equipment_transactions')
      .update({ signature_key: key, signed_at: new Date().toISOString() })
      .eq('id', txnId)
      .select(TXN_COLUMNS)
      .maybeSingle()
    if (err) {
      console.error('equipment-signature-upload:', err.message)
      return json({ error: '署名の登録に失敗しました' }, 500)
    }
    return json({ transaction: data })
  } catch (err) {
    console.error('equipment-signature-upload 失敗:', err)
    return json({ error: '署名の登録に失敗しました' }, 500)
  }
}

// GET /api/equipment/signature?txn_id=… — 署名画像の本体（非公開バケット。JWT認証必須。4-3）
export async function handleEquipmentSignatureGet(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const txnId = new URL(req.url).searchParams.get('txn_id') || ''
    if (!txnId) return json({ error: 'txn_id は必須です' }, 400)

    const supabase = getAdminClient()
    const { data: txn } = await supabase
      .from('equipment_transactions')
      .select('signature_key')
      .eq('id', txnId)
      .maybeSingle()
    if (!txn?.signature_key) return json({ error: '署名が見つかりません' }, 404)

    const res = await getObject(txn.signature_key)
    if (!res.ok) {
      console.error('equipment-signature-get: storage が', res.status, 'を返した')
      return json({ error: '署名の取得に失敗しました' }, 404)
    }
    return new Response(res.body, {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' },
    })
  } catch (err) {
    console.error('equipment-signature-get 失敗:', err)
    return json({ error: '署名の取得に失敗しました' }, 500)
  }
}
