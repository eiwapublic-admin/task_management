// 廃棄物実測値管理（2026-09-03〜。docs/waste-plan.md）。BKBビル・一般廃棄物のみ対象。
// 権限は残留塩素・自主検査と同じ（owner・備品出庫限定ロールは閲覧のみ）。

import { json, verifyRequestAuth, canWrite } from './http.js'
import { getAdminClient } from './supabase-admin.js'
import { putObject, getObject } from './storage.js'
import { recognizeWasteSheet, resolveProvider, estimateCostUSD } from './ai/index.js'
import { checkDailyLimit, addTodayUsage, setLimitAlert } from './usageLimit.js'

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
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
const VALID_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])

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

function extFromMime(mime) {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/webp') return 'webp'
  return 'jpg'
}

// POST /api/waste/scans — 記入済みシートの写真をアップロードする（multipart/form-data）
export async function handleWasteScanUpload(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const form = await req.formData().catch(() => null)
    if (!form) return json({ error: 'ファイルの受け取りに失敗しました' }, 400)

    const targetMonth = String(form.get('target_month') || '')
    const file = form.get('file')
    if (!MONTH_PATTERN.test(targetMonth)) return json({ error: 'target_month の形式が不正です' }, 400)
    if (!file || typeof file === 'string') return json({ error: 'file は必須です' }, 400)
    if (file.size > MAX_UPLOAD_BYTES) return json({ error: 'ファイルが大きすぎます（10MBまで）' }, 413)
    if (!VALID_MIME.has(file.type)) return json({ error: '対応していない形式です（JPEG/PNG/WebP）' }, 415)

    const key = `waste-scans/${targetMonth}/${crypto.randomUUID()}.${extFromMime(file.type)}`
    await putObject(key, await file.arrayBuffer(), file.type)

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('waste_scans')
      .insert({ target_month: targetMonth, storage_key: key, mime: file.type })
      .select('id, target_month, storage_key, status, created_at')
      .single()
    if (err) {
      console.error('waste-scan-upload:', err.message)
      return json({ error: '画像の保存に失敗しました' }, 500)
    }
    return json({ scan: data })
  } catch (err) {
    console.error('waste-scan-upload 失敗:', err)
    return json({ error: '画像の保存に失敗しました' }, 500)
  }
}

// POST /api/waste/scans/recognize — アップロード済みの画像をClaude Visionで読み取り、
// 日×階の実測値を is_confirmed=false の下書きとして waste_records へ反映する。
// 既に値がある（他の取込・手入力済みの）マスは、OCRがそのマスをnullで返した場合は
// 上書きしない（読み取れなかった＝既存値を消す理由にはならないため）。
export async function handleWasteScanRecognize(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const scanId = payload?.scan_id
    if (typeof scanId !== 'string' || !scanId) return json({ error: 'scan_id は必須です' }, 400)

    const supabase = getAdminClient()
    const { data: scan } = await supabase
      .from('waste_scans')
      .select('id, target_month, storage_key, mime')
      .eq('id', scanId)
      .maybeSingle()
    if (!scan) return json({ error: '取込画像が見つかりません' }, 404)

    // サーキットブレーカー（2026-09-04）。本日のAI利用が上限に達していたら読み取らない。
    // **Claudeを呼ぶ前に判定すること**（呼んだ後では課金が発生してしまう）。
    const { data: aiSettings } = await supabase
      .from('settings')
      .select('key, value')
      .in('key', ['daily_api_cost_limit_usd', 'ai_provider'])
    const settingOf = (key) => (aiSettings || []).find((r) => r.key === key)?.value
    const aiProvider = resolveProvider(settingOf('ai_provider'))
    const limitState = await checkDailyLimit(supabase, settingOf('daily_api_cost_limit_usd'))
    if (limitState.exceeded) {
      await setLimitAlert(supabase, limitState.message)
      return json({ error: limitState.message }, 429)
    }

    const res = await getObject(scan.storage_key)
    if (!res.ok) return json({ error: '画像の取得に失敗しました' }, 500)
    const buf = await res.arrayBuffer()
    const base64 = Buffer.from(buf).toString('base64')

    const { days, usage } = await recognizeWasteSheet(
      base64,
      scan.mime || 'image/jpeg',
      { month: scan.target_month, floors: WASTE_FLOORS },
      aiProvider
    )

    await addTodayUsage(supabase, {
      input: usage.input_tokens,
      output: usage.output_tokens,
      calls: 1,
      provider: aiProvider,
    })

    const month = new Date().toISOString().slice(0, 7)
    const { error: usageErr } = await supabase.rpc('add_api_usage', {
      p_month: month,
      p_input: usage.input_tokens,
      p_output: usage.output_tokens,
      p_calls: 1,
      p_fax_calls: 0,
      p_fax_input: 0,
      p_fax_output: 0,
      p_parking_calls: 0,
      p_waste_calls: 1,
      p_cost: estimateCostUSD(aiProvider, usage.input_tokens, usage.output_tokens),
    })
    // 記録に失敗すると、実際には課金されているのに従量課金事項の画面に出ない状態になる。
    // console.error だけでは画面から気づけないため、処理ログにも残す（2026-09-04）。
    if (usageErr) {
      console.error('waste-recognize(usage):', usageErr.message)
      await supabase.from('activity_logs').insert({
        log_type: 'error',
        actor: 'システム（自動）',
        message: `廃棄物スキャンのAI読み取りの利用量記録に失敗しました（${usageErr.message}）。実際のAPI利用は発生しているため、従量課金事項の表示が実額より少なくなります。`,
      })
    }

    // 読み取れたマスだけを upsert 候補にする（null は既存値を消さないよう対象外）
    const rows = []
    for (const [day, byFloor] of Object.entries(days || {})) {
      const dayNum = Number(day)
      if (!Number.isInteger(dayNum) || dayNum < 1 || dayNum > 31) continue
      const recordDate = `${scan.target_month}-${String(dayNum).padStart(2, '0')}`
      if (!byFloor || typeof byFloor !== 'object') continue
      for (const floor of WASTE_FLOORS) {
        const raw = byFloor[floor]
        if (raw === null || raw === undefined) continue
        const weight = Number(raw)
        if (!Number.isFinite(weight) || weight < 0 || weight > 999.99) continue
        rows.push({
          record_date: recordDate,
          floor,
          weight_kg: Math.round(weight * 100) / 100,
          source: 'ocr',
          is_confirmed: false,
          scan_id: scan.id,
        })
      }
    }

    let saved = []
    if (rows.length > 0) {
      const { data, error: upsertErr } = await supabase
        .from('waste_records')
        .upsert(rows, { onConflict: 'record_date,floor' })
        .select(RECORD_COLUMNS)
      if (upsertErr) {
        console.error('waste-recognize(upsert):', upsertErr.message)
        return json({ error: '読み取り結果の保存に失敗しました' }, 500)
      }
      saved = data || []
    }

    await supabase
      .from('waste_scans')
      .update({ raw_result: days, status: 'pending' })
      .eq('id', scan.id)

    return json({ records: saved, read_count: rows.length })
  } catch (err) {
    console.error('waste-scan-recognize 失敗:', err)
    const message = err.isBillingError ? 'APIクレジット残高が不足しています' : '画像の解析に失敗しました'
    return json({ error: message }, err.isBillingError ? 402 : 500)
  }
}
