// 日報機能の API ハンドラ（2026-08-04〜）。
// タスク管理側のコードには手を入れず、このファイルに閉じて追加していく。
// 権限: staff/admin は読み書き、owner は GET のみ（日報を全て閲覧できるが書き込み不可）。
// 詳細は docs/daily-report-plan.md を参照。

import { json, verifyRequestAuth, canWrite } from './http.js'
import { getAdminClient } from './supabase-admin.js'
import { putObject, getObject, deleteObject } from './storage.js'
import { fetchHolidays } from './holidays.js'

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
    return json({
      reports: list.map((r) => ({ ...r, entries: byReport.get(r.id) || [] })),
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
  'id, report_id, category, storage_key, thumb_key, filename, mime, size, width, height, comment, taken_at, sort_order, created_at'

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

// GET /api/report/photos?report_id=… — 指定日報の写真メタ一覧
export async function handlePhotoList(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const reportId = new URL(req.url).searchParams.get('report_id') || ''
    if (!reportId) return json({ error: 'report_id は必須です' }, 400)

    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('report_photos')
      .select(PHOTO_COLUMNS)
      .eq('report_id', reportId)
      .order('sort_order', { ascending: true })
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
  'id, building, inspected_on, inspector, all_clear, items, note, periodic_result, confirmed_by, closed, created_at, updated_at'

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

// POST /api/report/inspections — 実施記録の作成/更新（同じビル・同じ日は上書き）
export async function handleInspectionSave(req) {
  const { auth, error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const building = String(payload?.building || '')
    const date = payload?.inspected_on
    if (!VALID_BUILDINGS.has(building)) return json({ error: 'building が不正です' }, 400)
    if (!isValidDate(date)) return json({ error: 'inspected_on が不正です' }, 400)

    // 休館日マーカー（2026-08-05）。点検データを持たない特別なレコードで、
    // 「その日は点検の必要が無かった」ことだけを記録する。誤操作を想定し、
    // 取り消しは専用ボタンから DELETE で行う（未入力の状態に戻す）。
    const closed = Boolean(payload?.closed)
    const items = closed ? {} : sanitizeItems(payload?.items)
    // 不備が1件でもあるなら「一斉に○」は成立しない。画面側の指定によらずサーバーで確定させる
    const allClear = !closed && Object.keys(items).length === 0 && payload?.all_clear !== false

    const periodic = payload?.periodic_result
    const row = {
      building,
      inspected_on: date,
      inspector: closed ? null : trimOrNull(payload?.inspector, 50),
      all_clear: allClear,
      items,
      note: closed || typeof payload?.note !== 'string' ? null : payload.note.trim().slice(0, 1000) || null,
      periodic_result: !closed && (periodic === 'ok' || periodic === 'ng') ? periodic : null,
      confirmed_by: closed ? null : trimOrNull(payload?.confirmed_by, 50),
      closed,
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
