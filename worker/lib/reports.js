// 日報機能の API ハンドラ（2026-08-04〜）。
// タスク管理側のコードには手を入れず、このファイルに閉じて追加していく。
// 権限: staff/admin は読み書き、owner は GET のみ（日報を全て閲覧できるが書き込み不可）。
// 詳細は docs/daily-report-plan.md を参照。

import { json, verifyRequestAuth, canWrite } from './http.js'
import { getAdminClient } from './supabase-admin.js'
import { putObject, getObject, deleteObject } from './storage.js'
import { fetchHolidays } from './holidays.js'
import { recognizeVehicle } from './anthropic.js'
import { signJwt, verifyJwt } from './jwt.js'

// 日報1件を返すときに読む列。明細は別クエリで取り、画面側で組み立てる
const REPORT_COLUMNS = 'id, report_date, worker_am, worker_pm, work_start, work_end, created_at, updated_at'
const ENTRY_COLUMNS = 'id, report_id, entry_time, content, source_task_id, sort_order'

// 一覧の取得上限。日報は1日1件なので 400 件で1年半以上を賄える
const LIST_LIMIT = 400

// 'YYYY-MM-DD' 形式かを検証する。日付は主キー相当なので厳格に見る
function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

// 'HH:MM' / 'HH:MM:SS' を 'HH:MM:SS' に正規化する。空文字・不正値は null（未入力）
function normalizeTime(value) {
  if (typeof value !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  const sec = Number(m[3] ?? 0)
  if (h > 23 || min > 59 || sec > 59) return null
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

function trimOrNull(value, max = 200) {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t ? t.slice(0, max) : null
}

// 認証と書き込み権限をまとめて確認する。
// 戻り値が Response ならそれをそのまま返す（呼び出し側で早期 return する）
async function requireAuth(req, { write = false } = {}) {
  const auth = await verifyRequestAuth(req)
  if (!auth) return { error: json({ error: '認証が必要です' }, 401) }
  if (write && !canWrite(auth)) {
    // owner は閲覧のみ。UI 側でも書き込み操作を無効化するが、サーバー側でも必ず拒否する
    return { error: json({ error: 'この操作を行う権限がありません' }, 403) }
  }
  return { auth }
}

// GET /api/reports — 日報一覧（日付の新しい順）。一覧表示用に明細の抜粋も返す。
export async function handleReportList(req) {
  const { auth, error } = await requireAuth(req)
  if (error) return error
  void auth
  try {
    const supabase = getAdminClient()
    const { data: reports, error: err } = await supabase
      .from('daily_reports')
      .select(REPORT_COLUMNS)
      .order('report_date', { ascending: false })
      .limit(LIST_LIMIT)
    if (err) {
      console.error('report-list:', err.message)
      return json({ error: '日報の取得に失敗しました' }, 500)
    }
    const list = reports || []
    if (list.length === 0) return json({ reports: [] })

    // 一覧に作業記録の抜粋を出すため、対象日報の明細をまとめて1回で取る（N+1を避ける）
    const { data: entries, error: entErr } = await supabase
      .from('report_entries')
      .select(ENTRY_COLUMNS)
      .in('report_id', list.map((r) => r.id))
      .order('sort_order', { ascending: true })
    if (entErr) {
      console.error('report-list(entries):', entErr.message)
      return json({ error: '日報の取得に失敗しました' }, 500)
    }
    const byReport = new Map()
    for (const e of entries || []) {
      if (!byReport.has(e.report_id)) byReport.set(e.report_id, [])
      byReport.get(e.report_id).push(e)
    }

    // 一覧の右端アイコン（写真あり／違反車両あり／残留塩素の測定あり）用。
    // 存在有無だけ分かればよいので件数はまとめて取らない
    const reportIds = list.map((r) => r.id)
    const [{ data: photoRows }, { data: parkingRows }, { data: chlorineRows }] = await Promise.all([
      supabase.from('report_photos').select('report_id').eq('category', 'work').in('report_id', reportIds),
      supabase.from('parking_violations').select('report_id').in('report_id', reportIds),
      supabase.from('chlorine_tests').select('report_id').in('report_id', reportIds),
    ])
    const photoSet = new Set((photoRows || []).map((p) => p.report_id))
    const parkingSet = new Set((parkingRows || []).map((p) => p.report_id))
    const chlorineSet = new Set((chlorineRows || []).map((p) => p.report_id))

    return json({
      reports: list.map((r) => ({
        ...r,
        entries: byReport.get(r.id) || [],
        has_photos: photoSet.has(r.id),
        has_parking: parkingSet.has(r.id),
        has_chlorine: chlorineSet.has(r.id),
      })),
    })
  } catch (err) {
    console.error('report-list 失敗:', err)
    return json({ error: '日報の取得に失敗しました' }, 500)
  }
}

// GET /api/report?date=YYYY-MM-DD — 指定日の日報1件（明細つき）。
// 未作成の日は 404 ではなく report:null を返す（画面側で新規作成の導線を出すため）。
export async function handleReportGet(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const date = new URL(req.url).searchParams.get('date') || ''
    if (!isValidDate(date)) return json({ error: 'date が不正です' }, 400)

    const supabase = getAdminClient()
    const { data: report, error: err } = await supabase
      .from('daily_reports')
      .select(REPORT_COLUMNS)
      .eq('report_date', date)
      .maybeSingle()
    if (err) {
      console.error('report-get:', err.message)
      return json({ error: '日報の取得に失敗しました' }, 500)
    }
    if (!report) return json({ report: null })

    const { data: entries, error: entErr } = await supabase
      .from('report_entries')
      .select(ENTRY_COLUMNS)
      .eq('report_id', report.id)
      .order('sort_order', { ascending: true })
    if (entErr) {
      console.error('report-get(entries):', entErr.message)
      return json({ error: '日報の取得に失敗しました' }, 500)
    }
    return json({ report: { ...report, entries: entries || [] } })
  } catch (err) {
    console.error('report-get 失敗:', err)
    return json({ error: '日報の取得に失敗しました' }, 500)
  }
}

// POST /api/report — 指定日の日報を作成する。既にあればそれを返す（冪等）。
export async function handleReportCreate(req) {
  const { auth, error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const date = payload?.report_date
    if (!isValidDate(date)) return json({ error: 'report_date が不正です' }, 400)

    const supabase = getAdminClient()
    // 同じ日に二重作成されないよう、まず既存を確認する（report_date は unique だが、
    // 競合時にエラーを返すより既存を返すほうが画面側の扱いが単純になる）
    const { data: existing } = await supabase
      .from('daily_reports')
      .select(REPORT_COLUMNS)
      .eq('report_date', date)
      .maybeSingle()
    if (existing) return json({ report: { ...existing, entries: [] } })

    // 作業者（午前/午後）は指定が無ければ入力者本人の名前を既定値にする（2026-08-05）。
    // 実際には入力者本人が作業していることが多く、選び直す手間を省くため。
    // 明示的に空文字を送ってきた場合（担当者を空にしたい場合）はそれを尊重する。
    const defaultWorker = auth.display_name || null
    const row = {
      report_date: date,
      worker_am: 'worker_am' in (payload || {}) ? trimOrNull(payload.worker_am, 50) : defaultWorker,
      worker_pm: 'worker_pm' in (payload || {}) ? trimOrNull(payload.worker_pm, 50) : defaultWorker,
      work_start: normalizeTime(payload?.work_start) ?? '09:00:00',
      work_end: normalizeTime(payload?.work_end) ?? '18:00:00',
      created_by: auth.sub,
    }
    const { data, error: err } = await supabase
      .from('daily_reports')
      .insert(row)
      .select(REPORT_COLUMNS)
      .single()
    if (err) {
      // unique 違反（同時作成）は既存を読み直して返す
      const { data: raced } = await supabase
        .from('daily_reports')
        .select(REPORT_COLUMNS)
        .eq('report_date', date)
        .maybeSingle()
      if (raced) return json({ report: { ...raced, entries: [] } })
      console.error('report-create:', err.message)
      return json({ error: '日報の作成に失敗しました' }, 500)
    }
    return json({ report: { ...data, entries: [] } })
  } catch (err) {
    console.error('report-create 失敗:', err)
    return json({ error: '日報の作成に失敗しました' }, 500)
  }
}

// PATCH /api/report — 日報ヘッダ（作業者・作業時間）の更新。
export async function handleReportUpdate(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const id = payload?.id
    if (typeof id !== 'string' || !id) return json({ error: 'id は必須です' }, 400)

    const patch = {}
    if ('worker_am' in payload) patch.worker_am = trimOrNull(payload.worker_am, 50)
    if ('worker_pm' in payload) patch.worker_pm = trimOrNull(payload.worker_pm, 50)
    if ('work_start' in payload) patch.work_start = normalizeTime(payload.work_start)
    if ('work_end' in payload) patch.work_end = normalizeTime(payload.work_end)
    if (Object.keys(patch).length === 0) return json({ error: '更新する項目がありません' }, 400)

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('daily_reports')
      .update(patch)
      .eq('id', id)
      .select(REPORT_COLUMNS)
      .maybeSingle()
    if (err) {
      console.error('report-update:', err.message)
      return json({ error: '日報の更新に失敗しました' }, 500)
    }
    if (!data) return json({ error: '日報が見つかりません' }, 404)
    return json({ report: data })
  } catch (err) {
    console.error('report-update 失敗:', err)
    return json({ error: '日報の更新に失敗しました' }, 500)
  }
}

// DELETE /api/report?id=… — 日報1件の削除（明細・写真・違反車両は DB 側の cascade で
// まとめて消える）。写真の Storage 実体は cascade に追従しないため、消す前に控えておいて
// DB 削除後に個別に消す（photo-delete/parking-delete と同じ順序）。
export async function handleReportDelete(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!id) return json({ error: 'id は必須です' }, 400)

    const supabase = getAdminClient()
    const { data: photos } = await supabase.from('report_photos').select('storage_key, thumb_key').eq('report_id', id)

    const { error: err } = await supabase.from('daily_reports').delete().eq('id', id)
    if (err) {
      console.error('report-delete:', err.message)
      return json({ error: '日報の削除に失敗しました' }, 500)
    }
    for (const p of photos || []) {
      await deleteObject(p.storage_key)
      if (p.thumb_key) await deleteObject(p.thumb_key)
    }
    return json({ ok: true })
  } catch (err) {
    console.error('report-delete 失敗:', err)
    return json({ error: '日報の削除に失敗しました' }, 500)
  }
}

// POST /api/report/entries — 作業記録の明細を追加する。
// タスク管理からの転記（source_task_id つき）もこの経路を使う。
export async function handleEntryCreate(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const reportId = payload?.report_id
    if (typeof reportId !== 'string' || !reportId) return json({ error: 'report_id は必須です' }, 400)

    const supabase = getAdminClient()
    // 対象の日報が実在することを確認してから追加する（存在しないIDでの作成を防ぐ）
    const { data: report } = await supabase
      .from('daily_reports')
      .select('id')
      .eq('id', reportId)
      .maybeSingle()
    if (!report) return json({ error: '日報が見つかりません' }, 404)

    // 末尾に追加する。既存の最大 sort_order の次を採番する
    const { data: last } = await supabase
      .from('report_entries')
      .select('sort_order')
      .eq('report_id', reportId)
      .order('sort_order', { ascending: false })
      .limit(1)
      .maybeSingle()

    const row = {
      report_id: reportId,
      entry_time: normalizeTime(payload?.entry_time),
      content: typeof payload?.content === 'string' ? payload.content.trim().slice(0, 2000) : '',
      source_task_id: typeof payload?.source_task_id === 'string' ? payload.source_task_id : null,
      sort_order: (last?.sort_order ?? -1) + 1,
    }
    const { data, error: err } = await supabase
      .from('report_entries')
      .insert(row)
      .select(ENTRY_COLUMNS)
      .single()
    if (err) {
      console.error('entry-create:', err.message)
      return json({ error: '作業記録の追加に失敗しました' }, 500)
    }
    return json({ entry: data })
  } catch (err) {
    console.error('entry-create 失敗:', err)
    return json({ error: '作業記録の追加に失敗しました' }, 500)
  }
}

// PATCH /api/report/entries — 明細の更新（時刻・内容・並び順）。
export async function handleEntryUpdate(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const id = payload?.id
    if (typeof id !== 'string' || !id) return json({ error: 'id は必須です' }, 400)

    const patch = {}
    if ('entry_time' in payload) patch.entry_time = normalizeTime(payload.entry_time)
    if ('content' in payload) {
      patch.content = typeof payload.content === 'string' ? payload.content.trim().slice(0, 2000) : ''
    }
    if ('sort_order' in payload && Number.isInteger(payload.sort_order)) {
      patch.sort_order = payload.sort_order
    }
    if (Object.keys(patch).length === 0) return json({ error: '更新する項目がありません' }, 400)

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('report_entries')
      .update(patch)
      .eq('id', id)
      .select(ENTRY_COLUMNS)
      .maybeSingle()
    if (err) {
      console.error('entry-update:', err.message)
      return json({ error: '作業記録の更新に失敗しました' }, 500)
    }
    if (!data) return json({ error: '作業記録が見つかりません' }, 404)
    return json({ entry: data })
  } catch (err) {
    console.error('entry-update 失敗:', err)
    return json({ error: '作業記録の更新に失敗しました' }, 500)
  }
}

// DELETE /api/report/entries?id=… — 明細の削除。
export async function handleEntryDelete(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!id) return json({ error: 'id は必須です' }, 400)

    const supabase = getAdminClient()
    const { error: err } = await supabase.from('report_entries').delete().eq('id', id)
    if (err) {
      console.error('entry-delete:', err.message)
      return json({ error: '作業記録の削除に失敗しました' }, 500)
    }
    return json({ ok: true })
  } catch (err) {
    console.error('entry-delete 失敗:', err)
    return json({ error: '作業記録の削除に失敗しました' }, 500)
  }
}

// GET /api/report/templates — 定型文の一覧（有効なもののみ・並び順）。
export async function handleTemplateList(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('routine_templates')
      .select('id, label, sort_order, is_active')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
    if (err) {
      console.error('template-list:', err.message)
      return json({ error: '定型文の取得に失敗しました' }, 500)
    }
    return json({ templates: data || [] })
  } catch (err) {
    console.error('template-list 失敗:', err)
    return json({ error: '定型文の取得に失敗しました' }, 500)
  }
}

// PUT /api/report/templates — 定型文を丸ごと差し替える（設定画面からの保存）。
// 受け取った配列の順序をそのまま sort_order にする。
export async function handleTemplateSave(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const labels = Array.isArray(payload?.labels) ? payload.labels : null
    if (!labels) return json({ error: 'labels は配列で指定してください' }, 400)
    if (labels.length > 200) return json({ error: '定型文が多すぎます（200件まで）' }, 400)

    const rows = labels
      .map((l) => (typeof l === 'string' ? l.trim() : ''))
      .filter(Boolean)
      .map((label, i) => ({ label: label.slice(0, 500), sort_order: i, is_active: true }))

    const supabase = getAdminClient()
    // 全消し→再作成にする。件数が少なく（数十件）、並び順の維持が単純になるため。
    // 明細側は定型文を「文字列としてコピー」して保持しているので、消しても過去の記録は壊れない。
    const { error: delErr } = await supabase.from('routine_templates').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    if (delErr) {
      console.error('template-save(delete):', delErr.message)
      return json({ error: '定型文の保存に失敗しました' }, 500)
    }
    if (rows.length > 0) {
      const { error: insErr } = await supabase.from('routine_templates').insert(rows)
      if (insErr) {
        console.error('template-save(insert):', insErr.message)
        return json({ error: '定型文の保存に失敗しました' }, 500)
      }
    }
    return json({ ok: true, count: rows.length })
  } catch (err) {
    console.error('template-save 失敗:', err)
    return json({ error: '定型文の保存に失敗しました' }, 500)
  }
}

// ============================================================
// 写真（Phase 2。2026-08-04〜）
// 保管は Supabase Storage の非公開バケット。取得は必ずこの API を通す。
// ============================================================

const PHOTO_COLUMNS =
  'id, report_id, category, parking_id, chlorine_id, storage_key, thumb_key, filename, mime, size, width, height, comment, taken_at, sort_order, created_at'

// 用途ごとの想定解像度（縮小はクライアント側で行う。ここは上限の検証用）。
// work=作業エビデンス720px / parking=不正駐車1280px（ナンバーの判読性を確保）
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 // 1ファイル10MB（縮小後は80KB程度の想定）
const VALID_CATEGORIES = new Set(['work', 'parking', 'chlorine'])
const VALID_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])

// 保管キーを組み立てる。日付で階層を切り、後から年単位で退避しやすくしておく
function buildStorageKey(reportDate, category, ext) {
  const uuid = crypto.randomUUID()
  return `${reportDate}/${category}/${uuid}.${ext}`
}

function extFromMime(mime) {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'application/pdf') return 'pdf'
  return 'jpg'
}

// GET /api/report/photos?report_id=…&category=…&chlorine_id=… — 写真メタ一覧。
// category を指定すると絞り込む（work=作業記録の写真 / parking=違反車両の写真 /
// chlorine=残留塩素等検査の写真。混在させないため）。
// chlorine_id を指定した場合は、その検査レコードの写真だけを返す（report_id は不要。
// 残留塩素の入力モーダルは日報ではなく検査レコード単位で写真を扱うため。2026-08-10）。
export async function handlePhotoList(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const params = new URL(req.url).searchParams
    const reportId = params.get('report_id') || ''
    const category = params.get('category') || ''
    const chlorineId = params.get('chlorine_id') || ''
    if (!reportId && !chlorineId) return json({ error: 'report_id は必須です' }, 400)
    if (category && !VALID_CATEGORIES.has(category)) return json({ error: 'category が不正です' }, 400)

    const supabase = getAdminClient()
    let query = supabase.from('report_photos').select(PHOTO_COLUMNS)
    if (reportId) query = query.eq('report_id', reportId)
    if (chlorineId) query = query.eq('chlorine_id', chlorineId)
    if (category) query = query.eq('category', category)
    const { data, error: err } = await query.order('sort_order', { ascending: true })
    if (err) {
      console.error('photo-list:', err.message)
      return json({ error: '写真の取得に失敗しました' }, 500)
    }
    return json({ photos: data || [] })
  } catch (err) {
    console.error('photo-list 失敗:', err)
    return json({ error: '写真の取得に失敗しました' }, 500)
  }
}

// POST /api/report/photos — 写真のアップロード（multipart/form-data）。
// クライアント側で既に縮小済みのものを受け取る（通信量も抑えるため）。
export async function handlePhotoUpload(req) {
  const { auth, error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const form = await req.formData().catch(() => null)
    if (!form) return json({ error: 'ファイルの受け取りに失敗しました' }, 400)

    const reportId = String(form.get('report_id') || '')
    const category = String(form.get('category') || 'work')
    const parkingId = String(form.get('parking_id') || '') || null
    const chlorineId = String(form.get('chlorine_id') || '') || null
    const file = form.get('file')
    const thumb = form.get('thumb') // 一覧に写真が並ぶ用途のみ付く（任意）
    if (!reportId) return json({ error: 'report_id は必須です' }, 400)
    if (!VALID_CATEGORIES.has(category)) return json({ error: 'category が不正です' }, 400)
    if (!file || typeof file === 'string') return json({ error: 'file は必須です' }, 400)
    if (file.size > MAX_UPLOAD_BYTES) return json({ error: 'ファイルが大きすぎます（10MBまで）' }, 413)
    if (!VALID_MIME.has(file.type)) return json({ error: '対応していない形式です' }, 415)

    const supabase = getAdminClient()
    // 対象の日報が実在することを確認してから保存する
    const { data: report } = await supabase
      .from('daily_reports')
      .select('id, report_date')
      .eq('id', reportId)
      .maybeSingle()
    if (!report) return json({ error: '日報が見つかりません' }, 404)

    // 違反車両の写真は、対象レコードが同じ日報に属することを確認してから紐付ける
    if (parkingId) {
      const { data: violation } = await supabase
        .from('parking_violations')
        .select('id')
        .eq('id', parkingId)
        .eq('report_id', reportId)
        .maybeSingle()
      if (!violation) return json({ error: '違反車両のレコードが見つかりません' }, 404)
    }

    // 残留塩素等検査の写真も同様に、対象レコードが同じ日報に属することを確認する
    if (chlorineId) {
      const { data: test } = await supabase
        .from('chlorine_tests')
        .select('id')
        .eq('id', chlorineId)
        .eq('report_id', reportId)
        .maybeSingle()
      if (!test) return json({ error: '残留塩素等検査のレコードが見つかりません' }, 404)
    }

    const key = buildStorageKey(report.report_date, category, extFromMime(file.type))
    await putObject(key, file.stream(), file.type)

    // サムネイルは任意。保存に失敗しても本体は残す（一覧表示が本体で代替できるため）
    let thumbKey = null
    if (thumb && typeof thumb !== 'string' && thumb.size > 0 && VALID_MIME.has(thumb.type)) {
      try {
        thumbKey = await putObject(`${key}.thumb.jpg`, thumb.stream(), thumb.type)
      } catch (e) {
        console.error('thumb put 失敗（本体は保存済み）:', e)
      }
    }

    const { data: last } = await supabase
      .from('report_photos')
      .select('sort_order')
      .eq('report_id', reportId)
      .order('sort_order', { ascending: false })
      .limit(1)
      .maybeSingle()

    const takenAt = String(form.get('taken_at') || '')
    const row = {
      report_id: reportId,
      category,
      parking_id: parkingId,
      chlorine_id: chlorineId,
      storage_key: key,
      thumb_key: thumbKey,
      filename: String(form.get('filename') || file.name || '').slice(0, 255) || null,
      mime: file.type,
      size: file.size,
      width: Number(form.get('width')) || null,
      height: Number(form.get('height')) || null,
      comment: String(form.get('comment') || '').trim().slice(0, 500) || null,
      taken_at: takenAt && !Number.isNaN(Date.parse(takenAt)) ? takenAt : null,
      sort_order: (last?.sort_order ?? -1) + 1,
      created_by: auth.sub,
    }
    const { data, error: err } = await supabase
      .from('report_photos')
      .insert(row)
      .select(PHOTO_COLUMNS)
      .single()
    if (err) {
      // DB に入らなかった場合は保管したオブジェクトを消して孤児を残さない
      await deleteObject(key)
      if (thumbKey) await deleteObject(thumbKey)
      console.error('photo-upload:', err.message)
      return json({ error: '写真の保存に失敗しました' }, 500)
    }
    return json({ photo: data })
  } catch (err) {
    console.error('photo-upload 失敗:', err)
    return json({ error: '写真の保存に失敗しました' }, 500)
  }
}

// GET /api/report/photo?id=…&thumb=1 — 写真の本体を返す。
// バケットは非公開なので、この経路（JWT 認証済み）以外からは取得できない。
export async function handlePhotoGet(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const params = new URL(req.url).searchParams
    const id = params.get('id') || ''
    const wantThumb = params.get('thumb') === '1'
    if (!id) return json({ error: 'id は必須です' }, 400)

    const supabase = getAdminClient()
    const { data: photo } = await supabase
      .from('report_photos')
      .select('storage_key, thumb_key, mime, filename')
      .eq('id', id)
      .maybeSingle()
    if (!photo) return json({ error: '写真が見つかりません' }, 404)

    // サムネイル要求でも無ければ本体で代替する（表示が欠けないようにする）
    const key = wantThumb && photo.thumb_key ? photo.thumb_key : photo.storage_key
    const res = await getObject(key)
    if (!res.ok) {
      console.error('photo-get: storage が', res.status, 'を返した')
      return json({ error: '写真の取得に失敗しました' }, 404)
    }
    return new Response(res.body, {
      status: 200,
      headers: {
        'Content-Type': wantThumb && photo.thumb_key ? 'image/jpeg' : photo.mime || 'application/octet-stream',
        // 認証必須の内容なのでブラウザ共有キャッシュには載せない
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch (err) {
    console.error('photo-get 失敗:', err)
    return json({ error: '写真の取得に失敗しました' }, 500)
  }
}

// PATCH /api/report/photos — コメントの更新
export async function handlePhotoUpdate(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const id = payload?.id
    if (typeof id !== 'string' || !id) return json({ error: 'id は必須です' }, 400)
    if (!('comment' in payload)) return json({ error: '更新する項目がありません' }, 400)

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('report_photos')
      .update({ comment: String(payload.comment || '').trim().slice(0, 500) || null })
      .eq('id', id)
      .select(PHOTO_COLUMNS)
      .maybeSingle()
    if (err) {
      console.error('photo-update:', err.message)
      return json({ error: 'コメントの保存に失敗しました' }, 500)
    }
    if (!data) return json({ error: '写真が見つかりません' }, 404)
    return json({ photo: data })
  } catch (err) {
    console.error('photo-update 失敗:', err)
    return json({ error: 'コメントの保存に失敗しました' }, 500)
  }
}

// DELETE /api/report/photos?id=… — 写真の削除（保管したオブジェクトも消す）
export async function handlePhotoDelete(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!id) return json({ error: 'id は必須です' }, 400)

    const supabase = getAdminClient()
    const { data: photo } = await supabase
      .from('report_photos')
      .select('storage_key, thumb_key')
      .eq('id', id)
      .maybeSingle()
    if (!photo) return json({ ok: true }) // 既に無い場合も成功扱い（冪等）

    const { error: err } = await supabase.from('report_photos').delete().eq('id', id)
    if (err) {
      console.error('photo-delete:', err.message)
      return json({ error: '写真の削除に失敗しました' }, 500)
    }
    // DB から消えた後に実体を消す（順序が逆だと、実体だけ消えた孤児レコードが残りうる）
    await deleteObject(photo.storage_key)
    if (photo.thumb_key) await deleteObject(photo.thumb_key)
    return json({ ok: true })
  } catch (err) {
    console.error('photo-delete 失敗:', err)
    return json({ error: '写真の削除に失敗しました' }, 500)
  }
}

// GET /api/report/storage — ストレージ使用量（「従量課金事項」画面に表示する）
export async function handleStorageUsage(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('report_photos')
      .select('size, category')
    if (err) {
      console.error('storage-usage:', err.message)
      return json({ error: '使用量の取得に失敗しました' }, 500)
    }
    const rows = data || []
    const totalBytes = rows.reduce((sum, r) => sum + (r.size || 0), 0)
    const byCategory = {}
    for (const r of rows) {
      const c = r.category || 'work'
      if (!byCategory[c]) byCategory[c] = { count: 0, bytes: 0 }
      byCategory[c].count += 1
      byCategory[c].bytes += r.size || 0
    }
    return json({
      count: rows.length,
      total_bytes: totalBytes,
      // Supabase 無料プランの Storage 上限（1GB）。使用率の表示に使う
      quota_bytes: 1024 * 1024 * 1024,
      by_category: byCategory,
    })
  } catch (err) {
    console.error('storage-usage 失敗:', err)
    return json({ error: '使用量の取得に失敗しました' }, 500)
  }
}

// ============================================================
// 自主検査表（Phase 3。2026-08-04〜）
// 紙の様式「自主検査表(日常)」をそのまま置き換える。記入ルールは紙と同じで、
// 良好なら「点検箇所一斉」に○（all_clear=true）、不備のある項目だけ items に持つ。
// ============================================================

const INSPECTION_COLUMNS =
  'id, building, inspected_on, inspector, all_clear, items, note, periodic_result, confirmed_by, created_at, updated_at'

// 紙の様式に並ぶ検査項目（順序も紙に合わせる）。判定値は ok=良 / ng=不良 / fixed=即時改修。
// 「避難通路」「喫煙場所」は紙でも2行あるため区別してキーを分ける。
export const INSPECTION_ITEMS = [
  { key: '防火区画', group: '防火管理・避難管理' },
  { key: '避難通路1', label: '避難通路', group: '防火管理・避難管理' },
  { key: '避難通路2', label: '避難通路', group: '防火管理・避難管理' },
  { key: '通路非常照明', group: '防火管理・避難管理' },
  { key: '階段・防火戸', group: '防火管理・避難管理' },
  { key: '階段非常照明', group: '防火管理・避難管理' },
  { key: '非常用進入口', group: '防火管理・避難管理' },
  { key: 'カーテンじゅうたん等', group: '防火・火気使用・電気器具・喫煙' },
  { key: '喫煙場所1', label: '喫煙場所', group: '防火・火気使用・電気器具・喫煙' },
  { key: 'フード・ダクト', group: '防火・火気使用・電気器具・喫煙' },
  { key: 'ガス設備・器具', group: '防火・火気使用・電気器具・喫煙' },
  { key: '喫煙場所2', label: '喫煙場所', group: '防火・火気使用・電気器具・喫煙' },
  { key: '危険物等', group: '防火・火気使用・電気器具・喫煙' },
  { key: '消防用設備', group: '防火・火気使用・電気器具・喫煙' },
]

const ITEM_KEYS = new Set(INSPECTION_ITEMS.map((i) => i.key))
const VALID_JUDGEMENTS = new Set(['ok', 'ng', 'fixed'])
// 対象のビル。BKB＝備後町コイズミビルの略称
const VALID_BUILDINGS = new Set(['BKB', '小泉本社'])

// items は「不備のある項目だけ」を持つ。想定外のキー・値は落とす（画面の改造で
// 不正な値が混ざっても保存側で弾く）
function sanitizeItems(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!ITEM_KEYS.has(key)) continue
    if (!VALID_JUDGEMENTS.has(value)) continue
    // ok は既定なので保存しない（不備だけを持つ方針。記録が小さく済む）
    if (value === 'ok') continue
    out[key] = value
  }
  return out
}

// GET /api/report/inspections?month=YYYY-MM または ?date=&building=
export async function handleInspectionList(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const params = new URL(req.url).searchParams
    const month = params.get('month') || ''
    const date = params.get('date') || ''

    const supabase = getAdminClient()
    let query = supabase.from('fire_inspections').select(INSPECTION_COLUMNS)

    if (date) {
      if (!isValidDate(date)) return json({ error: 'date が不正です' }, 400)
      query = query.eq('inspected_on', date)
    } else if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: 'month が不正です' }, 400)
      // その月の1日から翌月1日の手前まで
      const [y, m] = month.split('-').map(Number)
      const from = `${month}-01`
      const to = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
      query = query.gte('inspected_on', from).lt('inspected_on', to)
    } else {
      // 指定が無ければ直近60日分（一覧の初期表示用）
      query = query.order('inspected_on', { ascending: false }).limit(120)
    }

    const { data, error: err } = await query.order('inspected_on', { ascending: false })
    if (err) {
      console.error('inspection-list:', err.message)
      return json({ error: '自主検査表の取得に失敗しました' }, 500)
    }
    return json({ inspections: data || [] })
  } catch (err) {
    console.error('inspection-list 失敗:', err)
    return json({ error: '自主検査表の取得に失敗しました' }, 500)
  }
}

// POST /api/report/inspections — 実施記録の作成/更新（同じビル・同じ日は上書き）。
// 休館日（closed_days。2026-08-07〜）はこのテーブルの管轄外。呼び出し側は休館日にする/
// 解除するときは /api/report/closed-days を使う（POST /api/report/closed-days が
// 休館日にする際にこのテーブルの当日分を削除するため、ここでは closed を一切扱わない）。
export async function handleInspectionSave(req) {
  const { auth, error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const building = String(payload?.building || '')
    const date = payload?.inspected_on
    if (!VALID_BUILDINGS.has(building)) return json({ error: 'building が不正です' }, 400)
    if (!isValidDate(date)) return json({ error: 'inspected_on が不正です' }, 400)

    const items = sanitizeItems(payload?.items)
    // 不備が1件でもあるなら「一斉に○」は成立しない。画面側の指定によらずサーバーで確定させる
    const allClear = Object.keys(items).length === 0 && payload?.all_clear !== false

    const periodic = payload?.periodic_result
    const row = {
      building,
      inspected_on: date,
      inspector: trimOrNull(payload?.inspector, 50),
      all_clear: allClear,
      items,
      note: typeof payload?.note !== 'string' ? null : payload.note.trim().slice(0, 1000) || null,
      periodic_result: periodic === 'ok' || periodic === 'ng' ? periodic : null,
      confirmed_by: trimOrNull(payload?.confirmed_by, 50),
      created_by: auth.sub,
    }

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('fire_inspections')
      .upsert(row, { onConflict: 'building,inspected_on' })
      .select(INSPECTION_COLUMNS)
      .single()
    if (err) {
      console.error('inspection-save:', err.message)
      return json({ error: '自主検査表の保存に失敗しました' }, 500)
    }
    return json({ inspection: data })
  } catch (err) {
    console.error('inspection-save 失敗:', err)
    return json({ error: '自主検査表の保存に失敗しました' }, 500)
  }
}

// GET /api/report/holidays — 日本の祝日一覧（{日付: 祝日名}）。自主検査表の日付列の色分けに使う。
// 取得に失敗しても画面自体は表示できるよう、空オブジェクトを返す（土日の色分けだけは効く）。
export async function handleHolidays(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const holidays = await fetchHolidays()
    return json({ holidays })
  } catch (err) {
    console.error('holidays 取得失敗:', err)
    return json({ holidays: {} })
  }
}

// DELETE /api/report/inspections?id=… — 実施記録の取り消し
export async function handleInspectionDelete(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!id) return json({ error: 'id は必須です' }, 400)
    const supabase = getAdminClient()
    const { error: err } = await supabase.from('fire_inspections').delete().eq('id', id)
    if (err) {
      console.error('inspection-delete:', err.message)
      return json({ error: '自主検査表の削除に失敗しました' }, 500)
    }
    return json({ ok: true })
  } catch (err) {
    console.error('inspection-delete 失敗:', err)
    return json({ error: '自主検査表の削除に失敗しました' }, 500)
  }
}

// ============================================================
// 自主検査表PDFのアプリ内プレビュー（2026-08-07）。
// jsPDFのpdf.save()はiOS Safari（特にホーム画面追加のstandalone表示）でdownload属性が
// 無視されblob URLへナビゲートしてしまい、閉じる操作の戻り先が無く画面が真っ白になる
// （プロジェクトスキル print-and-pdf-download Gotcha 8）。既存の添付ファイルプレビュー
// （handleAttachmentPreviewToken/handleDownloadAttachment、worker/index.js）と同じ
// 「短時間有効な署名トークン + 実URLへの<iframe>ナビゲーション」方式を使い、共有シートを
// 自動で出さずアプリ内でプレビュー→×で戻れるようにする（画面遷移が一切発生しないため、
// standaloneでも「戻り先が無い」問題自体が起きない）。
// 保存先キーはユーザーごとに固定（upsert）にして生成のたびに上書きし、溜め込まない。
// ============================================================

const PDF_PREVIEW_TTL_SECONDS = 180
const MAX_PDF_PREVIEW_BYTES = 20 * 1024 * 1024 // 自主検査表PDFは通常1MB未満。念のため上限を設ける

function pdfPreviewKey(userId) {
  return `inspection-pdf-preview/${userId}.pdf`
}

// POST /api/report/inspection-pdf-preview — 生成済みPDF（本体そのもの）を一時保存し、
// プレビュー用の短時間有効トークンを発行する。ログイン必須（書き込み権限は不要）
export async function handleInspectionPdfPreviewCreate(req) {
  const { auth, error } = await requireAuth(req)
  if (error) return error
  try {
    const bytes = await req.arrayBuffer()
    if (!bytes.byteLength) return json({ error: 'PDFが空です' }, 400)
    if (bytes.byteLength > MAX_PDF_PREVIEW_BYTES) return json({ error: 'PDFが大きすぎます' }, 413)

    const { SESSION_SECRET } = process.env
    if (!SESSION_SECRET) {
      console.error('inspection-pdf-preview: SESSION_SECRET が設定されていません')
      return json({ error: 'サーバー設定エラーが発生しました' }, 500)
    }

    const key = pdfPreviewKey(auth.sub)
    await putObject(key, bytes, 'application/pdf', { upsert: true })
    const token = await signJwt(
      { purpose: 'inspection-pdf-preview', key },
      SESSION_SECRET,
      PDF_PREVIEW_TTL_SECONDS
    )
    return json({ token })
  } catch (err) {
    console.error('inspection-pdf-preview-create 失敗:', err)
    return json({ error: 'PDFプレビューの準備に失敗しました' }, 500)
  }
}

// GET /api/report/inspection-pdf-preview?token=…&filename=… — PDF本体を返す。
// <iframe src>はAuthorizationヘッダを送れないため、上記で発行した短時間トークンを
// クエリ文字列で受け取り、通常のBearer認証の代わりとする。
export async function handleInspectionPdfPreviewGet(req) {
  const params = new URL(req.url).searchParams
  const token = params.get('token') || ''
  const { SESSION_SECRET } = process.env
  const claims = SESSION_SECRET && token ? await verifyJwt(token, SESSION_SECRET) : null
  if (!claims || claims.purpose !== 'inspection-pdf-preview' || !claims.key) {
    return json({ error: '認証が必要です' }, 401)
  }
  try {
    const res = await getObject(claims.key)
    if (!res.ok) {
      console.error('inspection-pdf-preview-get: storage が', res.status, 'を返した')
      return json({ error: 'PDFの取得に失敗しました' }, 404)
    }
    const filename = (params.get('filename') || 'inspection.pdf').slice(0, 255)
    const asciiName = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')
    const encodedName = encodeURIComponent(filename)
    return new Response(res.body, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
        'Cache-Control': 'private, no-store',
        // 自オリジンの<iframe>に埋め込めるようにする（handleDownloadAttachmentと同じ理由）
        'X-Frame-Options': 'SAMEORIGIN',
        'Content-Security-Policy': "frame-ancestors 'self'",
      },
    })
  } catch (err) {
    console.error('inspection-pdf-preview-get 失敗:', err)
    return json({ error: 'PDFの取得に失敗しました' }, 500)
  }
}

// ============================================================
// 休館日（2026-08-05に自主検査表専用のフラグとして追加 → 2026-08-07に closed_days
// テーブルへ切り出し、日報一覧とも共有するプロジェクト共通情報にした。
// ============================================================

// GET /api/report/closed-days?month=YYYY-MM — 指定月の休館日一覧（日付の配列）。
// month を省略した場合は全期間を返す（件数が少ない想定のため一覧のページングは行わない）。
export async function handleClosedDaysList(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const month = new URL(req.url).searchParams.get('month') || ''
    const supabase = getAdminClient()
    let query = supabase.from('closed_days').select('closed_on')
    if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: 'month が不正です' }, 400)
      const [y, m] = month.split('-').map(Number)
      const from = `${month}-01`
      const to = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
      query = query.gte('closed_on', from).lt('closed_on', to)
    }
    const { data, error: err } = await query.order('closed_on', { ascending: true })
    if (err) {
      console.error('closed-days-list:', err.message)
      return json({ error: '休館日の取得に失敗しました' }, 500)
    }
    return json({ closed_days: (data || []).map((r) => r.closed_on) })
  } catch (err) {
    console.error('closed-days-list 失敗:', err)
    return json({ error: '休館日の取得に失敗しました' }, 500)
  }
}

// POST /api/report/closed-days — 指定日を休館日にする。
// 休館日は点検データ・日報のどちらも持たない日という扱いのため、(1) 既に日報が
// 登録されている日は拒否し、(2) 自主検査表の記録があれば（点検データを持たない
// 休館日と両立しないため）削除してから登録する。
export async function handleClosedDayCreate(req) {
  const { auth, error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const date = payload?.date
    if (!isValidDate(date)) return json({ error: 'date が不正です' }, 400)

    const supabase = getAdminClient()
    const { data: existingReport } = await supabase
      .from('daily_reports')
      .select('id')
      .eq('report_date', date)
      .maybeSingle()
    if (existingReport) {
      return json({ error: 'この日はすでに日報が登録されているため休館日にできません' }, 400)
    }

    const { error: delErr } = await supabase.from('fire_inspections').delete().eq('inspected_on', date)
    if (delErr) {
      console.error('closed-day-create(delete inspections):', delErr.message)
      return json({ error: '休館日の登録に失敗しました' }, 500)
    }

    const { error: err } = await supabase
      .from('closed_days')
      .upsert({ closed_on: date, created_by: auth.sub }, { onConflict: 'closed_on' })
    if (err) {
      console.error('closed-day-create:', err.message)
      return json({ error: '休館日の登録に失敗しました' }, 500)
    }
    return json({ ok: true })
  } catch (err) {
    console.error('closed-day-create 失敗:', err)
    return json({ error: '休館日の登録に失敗しました' }, 500)
  }
}

// DELETE /api/report/closed-days?date=YYYY-MM-DD — 休館日の解除（未入力の状態に戻す）
export async function handleClosedDayDelete(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const date = new URL(req.url).searchParams.get('date') || ''
    if (!isValidDate(date)) return json({ error: 'date が不正です' }, 400)
    const supabase = getAdminClient()
    const { error: err } = await supabase.from('closed_days').delete().eq('closed_on', date)
    if (err) {
      console.error('closed-day-delete:', err.message)
      return json({ error: '休館日の解除に失敗しました' }, 500)
    }
    return json({ ok: true })
  } catch (err) {
    console.error('closed-day-delete 失敗:', err)
    return json({ error: '休館日の解除に失敗しました' }, 500)
  }
}

// ============================================================
// 不正駐車（Phase 4。2026-08-05〜）。日報詳細から写真と同様の流れで登録するが、
// 一覧は日を跨って独立した画面（/reports/parking）で見られるようにする。
// ============================================================

const PARKING_COLUMNS =
  'id, report_id, checked_at, plate_region, plate_number, maker, model, owner_company, violations, note, created_at, updated_at'

const VALID_VIOLATIONS = new Set(['unrecorded', 'false_entry', 'long_stay', 'after_hours', 'other'])

// violations は許可リストにある値だけを残す（画面の改造で不正な値が混ざっても保存側で弾く）
function sanitizeViolations(raw) {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((v) => VALID_VIOLATIONS.has(v)))]
}

// ナンバーは数字4桁のみを保持する（「-」等の区切り文字は除去。2026-08-05）
function sanitizePlateNumber(value) {
  if (typeof value !== 'string') return null
  const digits = value.replace(/\D/g, '').slice(0, 4)
  return digits || null
}

// GET /api/report/parking?report_id=… — report_id を指定すればその日だけ、
// 省略すれば全期間（新しい順・上限1000）を返す（違反車両一覧画面はこちらを使う）。
export async function handleParkingList(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const reportId = new URL(req.url).searchParams.get('report_id') || ''
    const supabase = getAdminClient()
    // 一覧画面（日を跨って表示）ではその日の日報へ戻れるよう report_date も一緒に返す
    let query = supabase.from('parking_violations').select(`${PARKING_COLUMNS}, daily_reports(report_date)`)
    if (reportId) query = query.eq('report_id', reportId)
    else query = query.limit(1000)
    const { data, error: err } = await query.order('checked_at', { ascending: false })
    if (err) {
      console.error('parking-list:', err.message)
      return json({ error: '違反車両の取得に失敗しました' }, 500)
    }
    const violations = (data || []).map(({ daily_reports, ...rest }) => ({
      ...rest,
      report_date: daily_reports?.report_date || null,
    }))
    return json({ violations })
  } catch (err) {
    console.error('parking-list 失敗:', err)
    return json({ error: '違反車両の取得に失敗しました' }, 500)
  }
}

// POST /api/report/parking — 違反車両レコードの新規作成。
// 写真と同様、まず空のレコードを作ってから写真をアップロードし、そのあと項目を埋めていく想定。
export async function handleParkingCreate(req) {
  const { auth, error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const reportId = payload?.report_id
    if (typeof reportId !== 'string' || !reportId) return json({ error: 'report_id は必須です' }, 400)

    const supabase = getAdminClient()
    const { data: report } = await supabase.from('daily_reports').select('id').eq('id', reportId).maybeSingle()
    if (!report) return json({ error: '日報が見つかりません' }, 404)

    const row = {
      report_id: reportId,
      checked_at: payload?.checked_at && !Number.isNaN(Date.parse(payload.checked_at)) ? payload.checked_at : new Date().toISOString(),
      plate_region: trimOrNull(payload?.plate_region, 20),
      plate_number: sanitizePlateNumber(payload?.plate_number),
      maker: trimOrNull(payload?.maker, 50),
      model: trimOrNull(payload?.model, 50),
      owner_company: trimOrNull(payload?.owner_company, 100),
      violations: sanitizeViolations(payload?.violations),
      note: trimOrNull(payload?.note, 1000),
      created_by: auth.sub,
    }
    const { data, error: err } = await supabase
      .from('parking_violations')
      .insert(row)
      .select(PARKING_COLUMNS)
      .single()
    if (err) {
      console.error('parking-create:', err.message)
      return json({ error: '違反車両の登録に失敗しました' }, 500)
    }
    return json({ violation: data })
  } catch (err) {
    console.error('parking-create 失敗:', err)
    return json({ error: '違反車両の登録に失敗しました' }, 500)
  }
}

// PATCH /api/report/parking — 項目の更新（ナンバー・車種・所有会社・違反事項・補足）。
export async function handleParkingUpdate(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const id = payload?.id
    if (typeof id !== 'string' || !id) return json({ error: 'id は必須です' }, 400)

    const patch = {}
    if ('plate_region' in payload) patch.plate_region = trimOrNull(payload.plate_region, 20)
    if ('plate_number' in payload) patch.plate_number = sanitizePlateNumber(payload.plate_number)
    if ('maker' in payload) patch.maker = trimOrNull(payload.maker, 50)
    if ('model' in payload) patch.model = trimOrNull(payload.model, 50)
    if ('owner_company' in payload) patch.owner_company = trimOrNull(payload.owner_company, 100)
    if ('violations' in payload) patch.violations = sanitizeViolations(payload.violations)
    if ('note' in payload) patch.note = trimOrNull(payload.note, 1000)
    if (Object.keys(patch).length === 0) return json({ error: '更新する項目がありません' }, 400)

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('parking_violations')
      .update(patch)
      .eq('id', id)
      .select(PARKING_COLUMNS)
      .maybeSingle()
    if (err) {
      console.error('parking-update:', err.message)
      return json({ error: '違反車両の更新に失敗しました' }, 500)
    }
    if (!data) return json({ error: '違反車両のレコードが見つかりません' }, 404)
    return json({ violation: data })
  } catch (err) {
    console.error('parking-update 失敗:', err)
    return json({ error: '違反車両の更新に失敗しました' }, 500)
  }
}

// DELETE /api/report/parking?id=… — レコードの削除（紐づく写真も cascade で消える）
export async function handleParkingDelete(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!id) return json({ error: 'id は必須です' }, 400)
    const supabase = getAdminClient()
    // Storage の実体は DB の cascade 削除に追従しないため、消す前に対象を控えておく
    const { data: photos } = await supabase.from('report_photos').select('storage_key, thumb_key').eq('parking_id', id)
    const { error: err } = await supabase.from('parking_violations').delete().eq('id', id)
    if (err) {
      console.error('parking-delete:', err.message)
      return json({ error: '違反車両の削除に失敗しました' }, 500)
    }
    // DB側は report_photos.parking_id の on delete cascade で自動的に消えるが、
    // Storage の実体は明示的に消さないと孤児が残る
    for (const p of photos || []) {
      await deleteObject(p.storage_key)
      if (p.thumb_key) await deleteObject(p.thumb_key)
    }
    return json({ ok: true })
  } catch (err) {
    console.error('parking-delete 失敗:', err)
    return json({ error: '違反車両の削除に失敗しました' }, 500)
  }
}

// POST /api/report/parking/recognize — 既にアップロード済みの違反車両写真から
// ナンバープレート・車種を読み取る（手動トリガー。自動実行ではない）。
// 費用の見える化のため、既存の Anthropic 利用量集計（api_usage）に加算する。
// 専用の内訳列は設けず、通常の分類呼び出しと同じ列に含める（call件数は少ない想定のため）。
export async function handleParkingRecognize(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const photoId = payload?.photo_id
    if (typeof photoId !== 'string' || !photoId) return json({ error: 'photo_id は必須です' }, 400)

    const supabase = getAdminClient()
    const { data: photo } = await supabase
      .from('report_photos')
      .select('storage_key, mime, category')
      .eq('id', photoId)
      .maybeSingle()
    if (!photo) return json({ error: '写真が見つかりません' }, 404)
    if (photo.category !== 'parking') return json({ error: '違反車両の写真ではありません' }, 400)

    const res = await getObject(photo.storage_key)
    if (!res.ok) return json({ error: '写真の取得に失敗しました' }, 500)
    const buf = await res.arrayBuffer()
    const base64 = Buffer.from(buf).toString('base64')

    const { result, usage } = await recognizeVehicle(base64, photo.mime || 'image/jpeg')

    const month = new Date().toISOString().slice(0, 7)
    const { error: usageErr } = await supabase.rpc('add_api_usage', {
      p_month: month,
      p_input: usage.input_tokens,
      p_output: usage.output_tokens,
      p_calls: 1,
      p_fax_calls: 0,
      p_fax_input: 0,
      p_fax_output: 0,
      p_parking_calls: 1,
    })
    if (usageErr) console.error('parking-recognize(usage):', usageErr.message)

    return json({
      plate_region: typeof result.plate_region === 'string' ? result.plate_region : null,
      plate_number: sanitizePlateNumber(result.plate_number),
      maker: typeof result.maker === 'string' ? result.maker : null,
      model: typeof result.model === 'string' ? result.model : null,
    })
  } catch (err) {
    console.error('parking-recognize 失敗:', err)
    const message = err.isBillingError ? 'APIクレジット残高が不足しています' : '写真の解析に失敗しました'
    return json({ error: message }, err.isBillingError ? 402 : 500)
  }
}

// ============================================================
// 残留塩素等検査（Phase 5。2026-08-10）。
// BKB・小泉本社などで週1回、残留塩素濃度を測定し、検査薬の色変化の写真と
// 色/濁り/臭気/味の判定を記録する。年単位・建物別に「残留塩素等検査実施記録表」
// としてPDF出力し、小泉産業様へ提出する。
//
// 違反車両と同じく日を跨って一覧するため daily_reports とは独立した行として持つが、
// 写真（report_photos）が日報に属する設計のため、測定日の日報に紐付ける
// （その日の日報が無ければここで作成する。測定＝その日の作業実績のため）。
// ============================================================

const CHLORINE_COLUMNS =
  'id, report_id, building, location, tested_at, concentration, color_ok, turbidity_ok, odor_ok, taste_ok, inspector, note, created_at, updated_at'

// 測定施設。BKB＝備後町コイズミビルの略称。
// 現行アプリ（FileMaker）のTOP画面には「スイングビル」もあったが、実際に測定するのは
// この2施設のみとの確認により対象外にした（2026-08-10）。
const VALID_CHLORINE_BUILDINGS = new Set(['BKB', '小泉本社'])

// 濃度は 0〜99.99 mg/L の範囲で小数第2位まで（DBは numeric(4,2)）。
// 未測定（記録だけ先に作る場合）は null を許す。
function sanitizeConcentration(value) {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0 || num > 99.99) return null
  return Math.round(num * 100) / 100
}

// OK/NG の判定。true=OK / false=NG / それ以外（未選択）は null
function sanitizeJudgement(value) {
  if (value === true || value === false) return value
  return null
}

// 'YYYY-MM-DD'（JST）に直す。日報（daily_reports.report_date）はJSTの日付で持つため、
// タイムゾーン付きの測定日時から必ずこの関数で日付を求める
function toJstDate(isoString) {
  return new Date(isoString).toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
}

// 測定日の日報を取得し、無ければ作成して id を返す。
// 写真が日報に属する設計のため、検査レコードは必ずいずれかの日報に紐付ける。
async function resolveReportIdForDate(supabase, date, auth) {
  const { data: existing } = await supabase
    .from('daily_reports')
    .select('id')
    .eq('report_date', date)
    .maybeSingle()
  if (existing) return existing.id

  const worker = auth.display_name || null
  const { data: created, error: err } = await supabase
    .from('daily_reports')
    .insert({
      report_date: date,
      worker_am: worker,
      worker_pm: worker,
      work_start: '09:00:00',
      work_end: '18:00:00',
      created_by: auth.sub,
    })
    .select('id')
    .single()
  if (!err) return created.id

  // unique 違反（同時作成）は既存を読み直す
  const { data: raced } = await supabase
    .from('daily_reports')
    .select('id')
    .eq('report_date', date)
    .maybeSingle()
  if (raced) return raced.id
  throw new Error(err.message)
}

// GET /api/report/chlorine?year=YYYY&building=… — 測定記録の一覧（測定日時の新しい順）。
// year / building は任意。省略時は全期間・全施設（上限1000件）を返す。
export async function handleChlorineList(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const params = new URL(req.url).searchParams
    const year = params.get('year') || ''
    const building = params.get('building') || ''

    const supabase = getAdminClient()
    let query = supabase.from('chlorine_tests').select(`${CHLORINE_COLUMNS}, daily_reports(report_date)`)

    if (year) {
      if (!/^\d{4}$/.test(year)) return json({ error: 'year が不正です' }, 400)
      // JST基準の1年間（UTCで持つ tested_at を JST の年で切るため -09:00 を明示する）
      query = query.gte('tested_at', `${year}-01-01T00:00:00+09:00`).lt('tested_at', `${Number(year) + 1}-01-01T00:00:00+09:00`)
    }
    if (building) {
      if (!VALID_CHLORINE_BUILDINGS.has(building)) return json({ error: 'building が不正です' }, 400)
      query = query.eq('building', building)
    }

    const { data, error: err } = await query.order('tested_at', { ascending: false }).limit(1000)
    if (err) {
      console.error('chlorine-list:', err.message)
      return json({ error: '残留塩素等検査の取得に失敗しました' }, 500)
    }
    // 記録元の日報へ戻れるよう report_date も一緒に返す（違反車両一覧と同じ扱い）
    const tests = (data || []).map(({ daily_reports, ...rest }) => ({
      ...rest,
      report_date: daily_reports?.report_date || null,
    }))
    return json({ tests })
  } catch (err) {
    console.error('chlorine-list 失敗:', err)
    return json({ error: '残留塩素等検査の取得に失敗しました' }, 500)
  }
}

// POST /api/report/chlorine — 測定記録の新規作成。
// report_id は受け取らず、測定日時（tested_at）のJST日付から日報を引き当てる/作成する。
export async function handleChlorineCreate(req) {
  const { auth, error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const building = String(payload?.building || '')
    if (!VALID_CHLORINE_BUILDINGS.has(building)) return json({ error: 'building が不正です' }, 400)

    const testedAt =
      payload?.tested_at && !Number.isNaN(Date.parse(payload.tested_at))
        ? new Date(payload.tested_at).toISOString()
        : new Date().toISOString()

    const supabase = getAdminClient()
    const reportId = await resolveReportIdForDate(supabase, toJstDate(testedAt), auth)

    const row = {
      report_id: reportId,
      building,
      location: trimOrNull(payload?.location, 100),
      tested_at: testedAt,
      concentration: sanitizeConcentration(payload?.concentration),
      color_ok: sanitizeJudgement(payload?.color_ok),
      turbidity_ok: sanitizeJudgement(payload?.turbidity_ok),
      odor_ok: sanitizeJudgement(payload?.odor_ok),
      taste_ok: sanitizeJudgement(payload?.taste_ok),
      inspector: trimOrNull(payload?.inspector, 50),
      note: trimOrNull(payload?.note, 1000),
      created_by: auth.sub,
    }
    const { data, error: err } = await supabase
      .from('chlorine_tests')
      .insert(row)
      .select(CHLORINE_COLUMNS)
      .single()
    if (err) {
      console.error('chlorine-create:', err.message)
      return json({ error: '残留塩素等検査の登録に失敗しました' }, 500)
    }
    return json({ test: data })
  } catch (err) {
    console.error('chlorine-create 失敗:', err)
    return json({ error: '残留塩素等検査の登録に失敗しました' }, 500)
  }
}

// PATCH /api/report/chlorine — 測定記録の更新。
// 測定日時を別の日に変更した場合は、紐付ける日報も新しい日付のものに付け替える
// （その日報に属する写真も一緒に移す。写真の保管キーは作成時の日付のままで問題ない）。
export async function handleChlorineUpdate(req) {
  const { auth, error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const id = payload?.id
    if (typeof id !== 'string' || !id) return json({ error: 'id は必須です' }, 400)

    const patch = {}
    if ('building' in payload) {
      if (!VALID_CHLORINE_BUILDINGS.has(String(payload.building))) {
        return json({ error: 'building が不正です' }, 400)
      }
      patch.building = String(payload.building)
    }
    if ('location' in payload) patch.location = trimOrNull(payload.location, 100)
    if ('concentration' in payload) patch.concentration = sanitizeConcentration(payload.concentration)
    if ('color_ok' in payload) patch.color_ok = sanitizeJudgement(payload.color_ok)
    if ('turbidity_ok' in payload) patch.turbidity_ok = sanitizeJudgement(payload.turbidity_ok)
    if ('odor_ok' in payload) patch.odor_ok = sanitizeJudgement(payload.odor_ok)
    if ('taste_ok' in payload) patch.taste_ok = sanitizeJudgement(payload.taste_ok)
    if ('inspector' in payload) patch.inspector = trimOrNull(payload.inspector, 50)
    if ('note' in payload) patch.note = trimOrNull(payload.note, 1000)

    const supabase = getAdminClient()
    if ('tested_at' in payload) {
      if (Number.isNaN(Date.parse(payload.tested_at))) return json({ error: 'tested_at が不正です' }, 400)
      const testedAt = new Date(payload.tested_at).toISOString()
      patch.tested_at = testedAt
      patch.report_id = await resolveReportIdForDate(supabase, toJstDate(testedAt), auth)
    }
    if (Object.keys(patch).length === 0) return json({ error: '更新する項目がありません' }, 400)

    const { data, error: err } = await supabase
      .from('chlorine_tests')
      .update(patch)
      .eq('id', id)
      .select(CHLORINE_COLUMNS)
      .maybeSingle()
    if (err) {
      console.error('chlorine-update:', err.message)
      return json({ error: '残留塩素等検査の更新に失敗しました' }, 500)
    }
    if (!data) return json({ error: '残留塩素等検査のレコードが見つかりません' }, 404)

    // 日付の変更で日報を付け替えた場合は、紐づく写真も同じ日報へ移す
    // （写真は report_id で日報に属するため、そのままだと元の日から辿れてしまう）
    if (patch.report_id) {
      const { error: photoErr } = await supabase
        .from('report_photos')
        .update({ report_id: patch.report_id })
        .eq('chlorine_id', id)
      if (photoErr) console.error('chlorine-update(photos):', photoErr.message)
    }
    return json({ test: data })
  } catch (err) {
    console.error('chlorine-update 失敗:', err)
    return json({ error: '残留塩素等検査の更新に失敗しました' }, 500)
  }
}

// DELETE /api/report/chlorine?id=… — 測定記録の削除（紐づく写真も cascade で消える）
export async function handleChlorineDelete(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!id) return json({ error: 'id は必須です' }, 400)
    const supabase = getAdminClient()
    // Storage の実体は DB の cascade 削除に追従しないため、消す前に対象を控えておく
    const { data: photos } = await supabase
      .from('report_photos')
      .select('storage_key, thumb_key')
      .eq('chlorine_id', id)
    const { error: err } = await supabase.from('chlorine_tests').delete().eq('id', id)
    if (err) {
      console.error('chlorine-delete:', err.message)
      return json({ error: '残留塩素等検査の削除に失敗しました' }, 500)
    }
    for (const p of photos || []) {
      await deleteObject(p.storage_key)
      if (p.thumb_key) await deleteObject(p.thumb_key)
    }
    return json({ ok: true })
  } catch (err) {
    console.error('chlorine-delete 失敗:', err)
    return json({ error: '残留塩素等検査の削除に失敗しました' }, 500)
  }
}
