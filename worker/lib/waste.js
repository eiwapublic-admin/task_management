// 廃棄物実測値管理（2026-09-03〜。docs/waste-plan.md）。BKBビル・一般廃棄物のみ対象。
// 権限は残留塩素・自主検査と同じ（owner・備品出庫限定ロールは閲覧のみ）。

import { json, verifyRequestAuth, canWrite } from './http.js'
import { getAdminClient } from './supabase-admin.js'
import { getAccessToken } from './gmail.js'
import { searchSpreadsheets, getFileMetadata, downloadAsXlsx, DRIVE_SHEET_MIME, XLSX_MIME } from './drive.js'

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
//
// 2026-09-30〜: month（'YYYY-MM'）を指定すると、その月の「未確認の下書き」のうち今回の
// ファイルに無い日×階を削除する（docs/waste-plan.md 10-8）。upsertは値のあるマスしか
// 上書きしないため、誤ったファイルを取り込んだ後に正しいファイルを取り込み直しても、
// 正しいファイルでは空欄のマスに前回の誤った値が残ってしまっていた。確認済みの行は
// 人が確定した値のため消さない。
export async function handleWasteRecordImport(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const rawRows = payload?.rows
    if (!Array.isArray(rawRows) || rawRows.length === 0) return json({ error: 'rows は必須です' }, 400)
    if (rawRows.length > MAX_IMPORT_ROWS) return json({ error: '行数が多すぎます' }, 400)

    const month = payload?.month || ''
    if (month && !MONTH_PATTERN.test(month)) return json({ error: 'month の形式が不正です' }, 400)

    const rows = []
    for (const raw of rawRows) {
      const { row, error: buildErr } = validateRecordPayload(raw)
      if (buildErr) return json({ error: buildErr }, 400)
      if (month && !row.record_date.startsWith(`${month}-`)) {
        return json({ error: '対象月以外の日付が含まれています' }, 400)
      }
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

    let removed = 0
    if (month) {
      const keep = new Set(rows.map((r) => `${r.record_date}|${r.floor}`))
      const { data: drafts, error: draftErr } = await supabase
        .from('waste_records')
        .select('id, record_date, floor')
        .eq('is_confirmed', false)
        .gte('record_date', `${month}-01`)
        .lt('record_date', `${shiftMonth(month, 1)}-01`)
      if (draftErr) {
        console.error('waste-record-import（残りの下書き取得）:', draftErr.message)
        return json({ error: '取り込みは完了しましたが、前回の下書きの整理に失敗しました' }, 500)
      }
      const staleIds = (drafts || []).filter((r) => !keep.has(`${r.record_date}|${r.floor}`)).map((r) => r.id)
      // id（UUID）を in() で渡すとURLが長くなるため、50件ずつに分けて削除する
      for (let i = 0; i < staleIds.length; i += 50) {
        const chunk = staleIds.slice(i, i + 50)
        const { error: delErr } = await supabase.from('waste_records').delete().in('id', chunk)
        if (delErr) {
          console.error('waste-record-import（残りの下書き削除）:', delErr.message)
          return json({ error: '取り込みは完了しましたが、前回の下書きの整理に失敗しました' }, 500)
        }
        removed += chunk.length
      }
    }
    return json({ records: data || [], imported: data?.length || 0, removed })
  } catch (err) {
    console.error('waste-record-import 失敗:', err)
    return json({ error: '実測値の取り込みに失敗しました' }, 500)
  }
}

// ============================================================
// Googleドライブからの取込（2026-09-30〜。docs/waste-plan.md 10-7）。
// AIチャット（Claude等）で手書き表を読み取らせるとGoogleドライブにスプレッドシートとして
// 保存されるため、ダウンロード→アップロードの手間を省いて直接取り込めるようにした。
// サーバーはファイルの中身（.xlsx）を返すだけで、読み取りは従来どおりブラウザ側の
// src/lib/wasteExcelImport.js が行い、保存は /api/waste/records/import を使う。
//
// 共有アカウント（eiwa.public@gmail.com）のドライブ全体を読める権限（drive.readonly）を使うため、
// 取込対象外のファイルを読み出す窓口にならないよう、名前に「廃棄物」を含む
// スプレッドシート（Googleスプレッドシート・.xlsx）だけに限定する。

const DRIVE_NAME_KEYWORD = '廃棄物'
const DRIVE_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/
// 実測集計表は数十KB程度。安全弁として上限を設ける
const MAX_DRIVE_FILE_BYTES = 5 * 1024 * 1024

function driveErrorResponse(err, fallback) {
  if (err?.isScopeError) {
    return json(
      {
        error:
          'Googleドライブの読み取り権限がありません。管理者がGoogle連携の権限（drive.readonly）を追加する必要があります。',
      },
      502
    )
  }
  if (err?.isApiDisabled) {
    return json({ error: 'Google Drive API が有効になっていません。管理者が Google Cloud で有効化してください。' }, 502)
  }
  if (err?.isNotFound) return json({ error: 'Googleドライブにファイルが見つかりませんでした' }, 404)
  return json({ error: fallback }, 500)
}

// GET /api/waste/drive-files — 名前に「廃棄物」を含むスプレッドシートを更新日の新しい順に返す
export async function handleWasteDriveFileList(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const accessToken = await getAccessToken()
    const files = await searchSpreadsheets(accessToken, DRIVE_NAME_KEYWORD, 20)
    return json({
      files: files.map((f) => ({ id: f.id, name: f.name, mime_type: f.mimeType, modified_time: f.modifiedTime })),
    })
  } catch (err) {
    console.error('waste-drive-file-list 失敗:', err)
    return driveErrorResponse(err, 'Googleドライブのファイル一覧を取得できませんでした')
  }
}

// GET /api/waste/drive-file?id=... — ファイルの中身を .xlsx で返す
export async function handleWasteDriveFileDownload(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  const id = new URL(req.url).searchParams.get('id') || ''
  if (!DRIVE_FILE_ID_PATTERN.test(id)) return json({ error: 'id の形式が不正です' }, 400)
  try {
    const accessToken = await getAccessToken()
    const meta = await getFileMetadata(accessToken, id)
    const allowedType = meta.mimeType === DRIVE_SHEET_MIME || meta.mimeType === XLSX_MIME
    if (meta.trashed || !allowedType || !(meta.name || '').includes(DRIVE_NAME_KEYWORD)) {
      return json({ error: '廃棄物実測集計表のスプレッドシートではありません' }, 400)
    }
    if (meta.mimeType === XLSX_MIME && Number(meta.size || 0) > MAX_DRIVE_FILE_BYTES) {
      return json({ error: 'ファイルが大きすぎます' }, 400)
    }
    const body = await downloadAsXlsx(accessToken, meta)
    if (body.byteLength > MAX_DRIVE_FILE_BYTES) return json({ error: 'ファイルが大きすぎます' }, 400)
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': XLSX_MIME, 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    console.error('waste-drive-file-download 失敗:', err)
    return driveErrorResponse(err, 'Googleドライブからファイルを取得できませんでした')
  }
}
