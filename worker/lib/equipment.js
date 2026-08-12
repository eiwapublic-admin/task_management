// 備品管理機能の API ハンドラ（Phase 1。2026-08-12〜）。
// 蛍光ランプ等の入出庫・在庫管理。現行 FileMaker「備品管理」アプリの移行。
// 権限: staff/admin は読み書き、owner は GET のみ（他画面と同じ方針。docs/equipment-plan.md 9章）。
// Phase 1 ではテナント設置（reason='tenant'）・新規入替（reason='replace'）・署名は扱わない
// （Phase 2 で追加）。DB・API は将来の拡張を見込んだ形にしてあるが、この段階で作れる画面・
// 入力は「調達／繰延登録／在庫調整」の入庫と「共用部設置／不良品処分」の出庫のみ。

import { json, verifyRequestAuth, canWrite } from './http.js'
import { getAdminClient } from './supabase-admin.js'

const ITEM_COLUMNS =
  'id, item_no, category_code, name, product_code, sort_order, warn_qty, warned_at, disabled, track_stock, note, created_at, updated_at'
const CATEGORY_COLUMNS = 'code, name, sort_order, note, created_at, updated_at'
const TXN_COLUMNS =
  'id, txn_no, item_id, kind, reason, occurred_at, quantity, supplier, tenant_id, tenant_code, tenant_name, ' +
  'tenant_short_name, floor, location, staff_name, signature_key, signed_at, note, created_by, updated_by, created_at, updated_at'

const VALID_KINDS = new Set(['in', 'out'])
const REASONS_BY_KIND = {
  in: new Set(['procure', 'deferred', 'adjust']),
  out: new Set(['tenant', 'common', 'replace', 'discard']),
}
// Phase 1 の画面から送信できる理由（tenant/replace は Phase 2 で解禁する）
const PHASE1_REASONS = new Set(['procure', 'deferred', 'adjust', 'common', 'discard'])

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

// GET /api/equipment/transactions?item_no=…&period=3m|1y|all — 指定した備品の入出庫明細。
// 残高（その時点の在庫）は対象備品の全履歴を古い順に積み上げて計算してから、
// 表示期間で絞り込む（期間フィルタで残高がずれないようにするため）。
export async function handleEquipmentTransactionList(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const params = new URL(req.url).searchParams
    const itemNo = params.get('item_no')
    if (!itemNo || !/^\d+$/.test(itemNo)) return json({ error: 'item_no が必要です' }, 400)
    const period = params.get('period') || '3m'

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

    let cutoff = null
    if (period === '3m') {
      cutoff = new Date()
      cutoff.setMonth(cutoff.getMonth() - 3)
    } else if (period === '1y') {
      cutoff = new Date()
      cutoff.setFullYear(cutoff.getFullYear() - 1)
    }
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
    if (!PHASE1_REASONS.has(reason)) {
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

    const row = {
      item_id: itemId,
      kind,
      reason,
      occurred_at: occurredAt,
      quantity,
      supplier: trimOrNull(payload.supplier, 200),
      floor: trimOrNull(payload.floor, 20),
      location: trimOrNull(payload.location, 200),
      staff_name: trimOrNull(payload.staff_name, 200),
      note: trimOrNull(payload.note, 1000),
      created_by: auth.sub,
      updated_by: auth.sub,
    }

    const supabase = getAdminClient()
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
      .select('id, item_id, kind, reason, signed_at')
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
    if ('floor' in payload) patch.floor = trimOrNull(payload.floor, 20)
    if ('location' in payload) patch.location = trimOrNull(payload.location, 200)
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
      .select('item_id, signed_at')
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
