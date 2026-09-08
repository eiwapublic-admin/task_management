// 古紙回収量の記録（備後町コイズミビル＝BKB。2026-09-08〜）。
// 毎週月曜に段ボール・シュレッダ・雑誌・その他を計量する運用を、従来のExcel
// （年度ごとのシート）から移したもの。廃棄物実測値管理（waste.js）と同じ権限
// （owner・備品出庫限定ロールは閲覧のみ）で扱う。
//
// 回収予定日（年度内の月曜）は画面側で自動生成するため、このテーブルには
// 「1件でも入力した回」だけが行として存在する。祝日・休館日で中止した回は
// skipped=true の行として残し、日程がずれた回は note に自由記入する。

import { json, verifyRequestAuth, canWrite } from './http.js'
import { getAdminClient } from './supabase-admin.js'

const RECORD_COLUMNS =
  'id, collect_date, skipped, cardboard_kg, shredder_kg, magazine_kg, other_kg, note, created_at, updated_at'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

// 計量値の列（画面・APIで共通の並び。合計は保存せず都度計算する）
const WEIGHT_FIELDS = ['cardboard_kg', 'shredder_kg', 'magazine_kg', 'other_kg']

async function requireAuth(req, { write = false } = {}) {
  const auth = await verifyRequestAuth(req)
  if (!auth) return { error: json({ error: '認証が必要です' }, 401) }
  if (write && !canWrite(auth)) {
    return { error: json({ error: 'この操作を行う権限がありません' }, 403) }
  }
  return { auth }
}

// 年度（4月〜翌3月）の範囲
function fiscalYearRange(fiscalYear) {
  const y = Number(fiscalYear)
  return { from: `${y}-04-01`, to: `${y + 1}-03-31` }
}

// GET /api/paper/records?fiscal_year=2026 — 年度内の記録（回収予定日の昇順）
export async function handlePaperRecordList(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const fiscalYear = new URL(req.url).searchParams.get('fiscal_year') || ''
    if (!/^\d{4}$/.test(fiscalYear)) return json({ error: 'fiscal_year の形式が不正です' }, 400)

    const { from, to } = fiscalYearRange(fiscalYear)
    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('paper_records')
      .select(RECORD_COLUMNS)
      .gte('collect_date', from)
      .lte('collect_date', to)
      .order('collect_date', { ascending: true })
    if (err) {
      console.error('paper-record-list:', err.message)
      return json({ error: '古紙回収量の取得に失敗しました' }, 500)
    }
    return json({ records: data || [] })
  } catch (err) {
    console.error('paper-record-list 失敗:', err)
    return json({ error: '古紙回収量の取得に失敗しました' }, 500)
  }
}

// 重量は空欄（未入力）を許す。空文字・null・undefined は null として保存し、
// 数値の場合だけ 0以上・小数第1位までに丸めて受け付ける
function parseWeight(value, label) {
  if (value === null || value === undefined || value === '') return { value: null }
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0 || num > 99999) return { error: `${label}の値が不正です` }
  return { value: Math.round(num * 10) / 10 }
}

function buildRecordRow(payload) {
  const collectDate = payload?.collect_date
  if (typeof collectDate !== 'string' || !DATE_PATTERN.test(collectDate)) {
    return { error: '回収予定日の形式が不正です' }
  }

  const labels = {
    cardboard_kg: '段ボール',
    shredder_kg: 'シュレッダ',
    magazine_kg: '雑誌',
    other_kg: 'その他',
  }
  const row = { collect_date: collectDate, skipped: Boolean(payload?.skipped) }
  for (const field of WEIGHT_FIELDS) {
    const parsed = parseWeight(payload?.[field], labels[field])
    if (parsed.error) return { error: parsed.error }
    row[field] = parsed.value
  }

  const note = typeof payload?.note === 'string' ? payload.note.trim() : ''
  row.note = note ? note.slice(0, 200) : null
  return { row }
}

// PUT /api/paper/records — 1回分の入力・訂正（回収予定日で upsert）
export async function handlePaperRecordUpsert(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const { row, error: buildErr } = buildRecordRow(payload)
    if (buildErr) return json({ error: buildErr }, 400)

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('paper_records')
      .upsert(row, { onConflict: 'collect_date' })
      .select(RECORD_COLUMNS)
      .single()
    if (err) {
      console.error('paper-record-upsert:', err.message)
      return json({ error: '古紙回収量の保存に失敗しました' }, 500)
    }
    return json({ record: data })
  } catch (err) {
    console.error('paper-record-upsert 失敗:', err)
    return json({ error: '古紙回収量の保存に失敗しました' }, 500)
  }
}

// DELETE /api/paper/records?id=… — 1回分の記録をまるごと取り消す
export async function handlePaperRecordDelete(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!id) return json({ error: 'id は必須です' }, 400)
    const supabase = getAdminClient()
    const { error: err } = await supabase.from('paper_records').delete().eq('id', id)
    if (err) {
      console.error('paper-record-delete:', err.message)
      return json({ error: '古紙回収量の削除に失敗しました' }, 500)
    }
    return json({ ok: true })
  } catch (err) {
    console.error('paper-record-delete 失敗:', err)
    return json({ error: '古紙回収量の削除に失敗しました' }, 500)
  }
}
