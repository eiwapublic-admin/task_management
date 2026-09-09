// 廃棄物実測値管理（2026-09-03〜。docs/waste-plan.md）。BKBビル・一般廃棄物のみ対象。
// 権限は残留塩素・自主検査と同じ（owner・備品出庫限定ロールは閲覧のみ）。

import { json, verifyRequestAuth, canWrite } from './http.js'
import { getAdminClient } from './supabase-admin.js'

export const WASTE_FLOORS = ['1', '2', '3', '4', '5', '6', '7']

const RECORD_COLUMNS =
  'id, record_date, floor, weight_kg, source, is_confirmed, scan_id, note, created_at, updated_at'

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

// 'YYYY-MM' を n か月ずらす（src/lib/reports.js の shiftMonth と同じ計算）
function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
// Excel取込1回あたりの上限行数（31日×7階=217で足りるが、安全弁として余裕を持たせる）
const MAX_IMPORT_ROWS = 400

async function requireAuth(req, { write = false } = {}) {
  const auth = await verifyRequestAuth(req)
  if (!auth) return { error: json({ error: '認証が必要です' }, 401) }
  if (write && !canWrite(auth)) {
    return { error: json({ error: 'この操作を行う権限がありません' }, 403) }
  }
  return { auth }
}

function fiscalYearRange(fiscalYear) {
  const y = Number(fiscalYear)
  return { from: `${y}-04-01`, to: `${y + 1}-03-31` }
}

// GET /api/waste/records?month=YYYY-MM または ?fiscal_year=2026（4月〜翌3月）
export async function handleWasteRecordList(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const params = new URL(req.url).searchParams
    const month = params.get('month') || ''
    const fiscalYear = params.get('fiscal_year') || ''
    if (!month && !fiscalYear) return json({ error: 'month または fiscal_year は必須です' }, 400)
    if (month && !MONTH_PATTERN.test(month)) return json({ error: 'month の形式が不正です' }, 400)

    const supabase = getAdminClient()
    let query = supabase.from('waste_records').select(RECORD_COLUMNS)
    if (month) {
      query = query.gte('record_date', `${month}-01`).lt('record_date', `${shiftMonth(month, 1)}-01`)
    } else {
      if (!/^\d{4}$/.test(fiscalYear)) return json({ error: 'fiscal_year の形式が不正です' }, 400)
      const { from, to } = fiscalYearRange(fiscalYear)
      query = query.gte('record_date', from).lte('record_date', to)
    }
    const { data, error: err } = await query.order('record_date', { ascending: true })
    if (err) {
      console.error('waste-record-list:', err.message)
      return json({ error: '実測値の取得に失敗しました' }, 500)
    }
    return json({ records: data || [] })
  } catch (err) {
    console.error('waste-record-list 失敗:', err)
    return json({ error: '実測値の取得に失敗しました' }, 500)
  }
}

function validateRecordPayload(payload) {
  const recordDate = payload?.record_date
  if (typeof recordDate !== 'string' || !DATE_PATTERN.test(recordDate)) {
    return { error: '記録日の形式が不正です' }
  }
  const floor = String(payload?.floor ?? '')
  if (!WASTE_FLOORS.includes(floor)) return { error: '階の指定が不正です' }
  const weight = Number(payload?.weight_kg)
  if (!Number.isFinite(weight) || weight < 0 || weight > 999.99) {
    return { error: '実測値（kg）が不正です' }
  }
  return { row: { record_date: recordDate, floor, weight_kg: Math.round(weight * 100) / 100 } }
}

// PUT /api/waste/records — 1マスの手入力・訂正（upsert）。手入力は常に is_confirmed=true・
// source='manual' にする（OCR結果を人が直したときも、触った時点で確認済み扱いにする）
export async function handleWasteRecordUpsert(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const { row, error: buildErr } = validateRecordPayload(payload)
    if (buildErr) return json({ error: buildErr }, 400)

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('waste_records')
      .upsert(
        { ...row, source: 'manual', is_confirmed: true, note: payload?.note ?? null },
        { onConflict: 'record_date,floor' }
      )
      .select(RECORD_COLUMNS)
      .single()
    if (err) {
      console.error('waste-record-upsert:', err.message)
      return json({ error: '実測値の保存に失敗しました' }, 500)
    }
    return json({ record: data })
  } catch (err) {
    console.error('waste-record-upsert 失敗:', err)
    return json({ error: '実測値の保存に失敗しました' }, 500)
  }
}

// DELETE /api/waste/records?id=… — マスの記録を削除（誤って作った行の取り消し）
export async function handleWasteRecordDelete(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!id) return json({ error: 'id は必須です' }, 400)
    const supabase = getAdminClient()
    const { error: err } = await supabase.from('waste_records').delete().eq('id', id)
    if (err) {
      console.error('waste-record-delete:', err.message)
      return json({ error: '実測値の削除に失敗しました' }, 500)
    }
    return json({ ok: true })
  } catch (err) {
    console.error('waste-record-delete 失敗:', err)
    return json({ error: '実測値の削除に失敗しました' }, 500)
  }
}

// POST /api/waste/records/confirm-month — その月の残り（OCR取込のまま未確認だった行）を
// まとめて確認済みにする。値を直したマスは既に upsert 時点で確認済みになっているため対象外
export async function handleWasteRecordConfirmMonth(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const month = payload?.month
    if (typeof month !== 'string' || !MONTH_PATTERN.test(month)) {
      return json({ error: 'month の形式が不正です' }, 400)
    }
    const supabase = getAdminClient()
    const { error: err } = await supabase
      .from('waste_records')
      .update({ is_confirmed: true })
      .gte('record_date', `${month}-01`)
      .lt('record_date', `${shiftMonth(month, 1)}-01`)
      .eq('is_confirmed', false)
    if (err) {
      console.error('waste-record-confirm-month:', err.message)
      return json({ error: '確認済みへの更新に失敗しました' }, 500)
    }
    return json({ ok: true })
  } catch (err) {
    console.error('waste-record-confirm-month 失敗:', err)
    return json({ error: '確認済みへの更新に失敗しました' }, 500)
  }
}

// POST /api/waste/records/import — Excel取込（2026-09-09〜。docs/waste-plan.md 5-2改訂）。
// 手書きシートの写真をClaude Visionで読み取る方式は実際の筆跡で読み取り失敗が続いたため、
// 依頼元がAIチャット等でExcel化した実測値をブラウザ側（src/lib/wasteExcelImport.js）で
// 読み取り、日×階の行データに変換した結果をここへまとめて送ってもらう方式に変更した。
// OCR取込と同じく is_confirmed=false の下書きとして保存し、Waste.jsx の編集グリッドで
// 人が確認・訂正してから確定する（画面自体は変えていない。取込元だけが変わった）。
export async function handleWasteRecordImport(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const rawRows = payload?.rows
    if (!Array.isArray(rawRows) || rawRows.length === 0) return json({ error: 'rows は必須です' }, 400)
    if (rawRows.length > MAX_IMPORT_ROWS) return json({ error: '行数が多すぎます' }, 400)

    const rows = []
    for (const raw of rawRows) {
      const { row, error: buildErr } = validateRecordPayload(raw)
      if (buildErr) return json({ error: buildErr }, 400)
      rows.push({ ...row, source: 'excel', is_confirmed: false })
    }

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('waste_records')
      .upsert(rows, { onConflict: 'record_date,floor' })
      .select(RECORD_COLUMNS)
    if (err) {
      console.error('waste-record-import:', err.message)
      return json({ error: '実測値の取り込みに失敗しました' }, 500)
    }
    return json({ records: data || [], imported: data?.length || 0 })
  } catch (err) {
    console.error('waste-record-import 失敗:', err)
    return json({ error: '実測値の取り込みに失敗しました' }, 500)
  }
}
