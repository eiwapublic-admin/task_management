// 業務マニュアル（日常業務の手引書）の API ハンドラ（2026-10-13〜）。
// 依頼元の「対応マニュアル.xlsx」の「対応マニュアル」「定例作業」シートと、定例作業から参照される
// 手順のシートを取り込んだもの（supabase/schema.sql の work_manuals のコメント参照）。
// 権限: 連絡帳と同じく社員（staff/admin）だけ。owner・備品出庫限定ロールには閲覧も許さない
// （鍵の場所・暗証番号など社内の手順を含むため。2026-10-13 依頼元に確認済み）。

import { json, verifyRequestAuth, canWrite } from './http.js'
import { getAdminClient } from './supabase-admin.js'
import { putObject, getObject, deleteObject, deleteObjects, TEMPLATE_BUCKET } from './storage.js'
import { signJwt, verifyJwt } from './jwt.js'

const COLUMNS = 'id, kind, no, title, fields, body, related_ids, created_at, updated_at'

// 添付ファイル（2026-10-26〜）。本体は雛形ファイルと同じ非公開バケット work-templates の manuals/ の下に置く
// （Supabase の無料枠 1GB の中。2026-10-26 時点の使用量は全バケットで約30MB）
const ATTACHMENT_COLUMNS = 'id, manual_id, filename, mime, file_size, created_at'
const ATTACHMENT_PREFIX = 'manuals/'
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024 // 1ファイル20MB（雛形ファイルと同じ）
const MAX_ATTACHMENTS = 20 // 1項目あたり
const PREVIEW_TTL_SECONDS = 120

// 分類ごとに持てる項目（fields のキー）。画面の見出しの順もこの順。
// 2026-10-13〜 分類は「対応方法（response）」「定例作業（routine）」の2つ（旧「関連手順（procedure）」は定例作業へ統合）。
// 手順の本文（body）はどちらの分類でも持てる
export const MANUAL_FIELDS = {
  response: ['method', 'contact', 'note'],
  routine: ['timing', 'items', 'place', 'content', 'after', 'remark'],
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function requireStaff(req) {
  const auth = await verifyRequestAuth(req)
  if (!auth) return { error: json({ error: '認証が必要です' }, 401) }
  if (!canWrite(auth)) return { error: json({ error: 'この画面を使う権限がありません' }, 403) }
  return { auth }
}

function text(value, max) {
  if (typeof value !== 'string') return ''
  return value.replace(/\r\n?/g, '\n').trim().slice(0, max)
}

// 画面から送られた値を、種類に合った形に整える。誤りがあれば { error }
function normalize(payload, kind) {
  const title = text(payload.title, 200)
  if (!title) return { error: '項目名（依頼・問い合わせ例／作業名／手順名）を入力してください' }
  const fields = {}
  for (const key of MANUAL_FIELDS[kind]) {
    const v = text(payload.fields?.[key], 4000)
    if (v) fields[key] = v
  }
  const body = text(payload.body, 20000) || null
  const related = Array.isArray(payload.related_ids)
    ? [...new Set(payload.related_ids.filter((id) => typeof id === 'string' && UUID_RE.test(id)))].slice(0, 20)
    : []
  const no = payload.no === '' || payload.no == null ? null : Number(payload.no)
  if (no !== null && (!Number.isInteger(no) || no < 0 || no > 9999)) return { error: 'No は0〜9999の整数で入力してください' }
  return { row: { title, fields, body, related_ids: related, no } }
}

// GET /api/manuals — 全件（種類→No 順）。キーワード検索は画面側で行う
export async function handleManualList(req) {
  const { error } = await requireStaff(req)
  if (error) return error
  try {
    const { data, error: err } = await getAdminClient()
      .from('work_manuals')
      .select(COLUMNS)
      .order('kind', { ascending: true })
      .order('no', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
    if (err) throw err
    const { data: files, error: fileErr } = await getAdminClient()
      .from('work_manual_attachments')
      .select(ATTACHMENT_COLUMNS)
      .order('created_at', { ascending: true })
    if (fileErr) throw fileErr
    const byManual = new Map()
    for (const f of files || []) {
      if (!byManual.has(f.manual_id)) byManual.set(f.manual_id, [])
      byManual.get(f.manual_id).push(f)
    }
    return json({ manuals: (data || []).map((m) => ({ ...m, attachments: byManual.get(m.id) || [] })) })
  } catch (err) {
    console.error('manual-list 失敗:', err)
    return json({ error: '業務マニュアルの取得に失敗しました' }, 500)
  }
}

// POST /api/manuals — 追加。No が空なら、その種類の最大 No + 1 を振る
export async function handleManualCreate(req) {
  const { auth, error } = await requireStaff(req)
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const kind = payload?.kind
    if (!MANUAL_FIELDS[kind]) return json({ error: '種類が不正です' }, 400)
    const { row, error: invalid } = normalize(payload, kind)
    if (invalid) return json({ error: invalid }, 400)

    const supabase = getAdminClient()
    if (row.no === null) {
      const { data: last } = await supabase
        .from('work_manuals')
        .select('no')
        .eq('kind', kind)
        .not('no', 'is', null)
        .order('no', { ascending: false })
        .limit(1)
        .maybeSingle()
      row.no = (last?.no || 0) + 1
    }
    const { data, error: err } = await supabase
      .from('work_manuals')
      .insert({ ...row, kind, created_by: auth.sub, updated_by: auth.sub })
      .select(COLUMNS)
      .single()
    if (err) throw err
    return json({ manual: data })
  } catch (err) {
    console.error('manual-create 失敗:', err)
    return json({ error: '業務マニュアルの追加に失敗しました' }, 500)
  }
}

// PATCH /api/manuals — 更新。分類（kind）も変えられる（2026-10-13〜。修正画面のラベルから選び直す）
export async function handleManualUpdate(req) {
  const { auth, error } = await requireStaff(req)
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const id = typeof payload?.id === 'string' ? payload.id : ''
    if (!UUID_RE.test(id)) return json({ error: 'id が不正です' }, 400)
    const supabase = getAdminClient()
    const { data: existing } = await supabase.from('work_manuals').select('id, kind').eq('id', id).maybeSingle()
    if (!existing) return json({ error: '項目が見つかりません' }, 404)
    const kind = MANUAL_FIELDS[payload.kind] ? payload.kind : existing.kind
    const { row, error: invalid } = normalize(payload, kind)
    if (invalid) return json({ error: invalid }, 400)
    row.kind = kind
    row.related_ids = row.related_ids.filter((r) => r !== id)
    const { data, error: err } = await supabase
      .from('work_manuals')
      .update({ ...row, updated_by: auth.sub })
      .eq('id', id)
      .select(COLUMNS)
      .single()
    if (err) throw err
    return json({ manual: data })
  } catch (err) {
    console.error('manual-update 失敗:', err)
    return json({ error: '業務マニュアルの更新に失敗しました' }, 500)
  }
}

// DELETE /api/manuals?id=… — 削除。ほかの項目の「関連」からも外す
export async function handleManualDelete(req) {
  const { error } = await requireStaff(req)
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!UUID_RE.test(id)) return json({ error: 'id が不正です' }, 400)
    const supabase = getAdminClient()
    const { data: referrers } = await supabase.from('work_manuals').select('id, related_ids').contains('related_ids', [id])
    for (const r of referrers || []) {
      await supabase
        .from('work_manuals')
        .update({ related_ids: (r.related_ids || []).filter((x) => x !== id) })
        .eq('id', r.id)
    }
    const { data: files } = await supabase.from('work_manual_attachments').select('storage_key').eq('manual_id', id)
    const { error: err } = await supabase.from('work_manuals').delete().eq('id', id)
    if (err) throw err
    // 添付の行は cascade で消える。ファイルは消せなくても項目の削除は成功として返す（孤児はログで追える）
    const keys = (files || []).map((f) => f.storage_key)
    if (keys.length) {
      await deleteObjects(keys, TEMPLATE_BUCKET).catch((e) => console.error('manual-delete: 添付ファイルの削除に失敗:', keys, e))
    }
    return json({ ok: true })
  } catch (err) {
    console.error('manual-delete 失敗:', err)
    return json({ error: '業務マニュアルの削除に失敗しました' }, 500)
  }
}

// ファイル名から拡張子を取る（ドット無し・小文字）。無ければ空文字
function extOf(filename) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(filename || '')
  return m ? m[1].toLowerCase() : ''
}

// POST /api/manuals/attachments — 添付ファイルを1つ追加（multipart/form-data: manual_id, file）
export async function handleManualAttachmentCreate(req) {
  const { auth, error } = await requireStaff(req)
  if (error) return error
  try {
    const form = await req.formData().catch(() => null)
    if (!form) return json({ error: 'ファイルの受け取りに失敗しました' }, 400)
    const manualId = String(form.get('manual_id') || '')
    const file = form.get('file')
    if (!UUID_RE.test(manualId)) return json({ error: 'manual_id が不正です' }, 400)
    if (!file || typeof file === 'string') return json({ error: 'ファイルを選んでください' }, 400)
    if (file.size > MAX_ATTACHMENT_BYTES) return json({ error: `「${file.name}」が大きすぎます（1ファイル20MBまで）` }, 413)

    const supabase = getAdminClient()
    const { data: manual } = await supabase.from('work_manuals').select('id').eq('id', manualId).maybeSingle()
    if (!manual) return json({ error: '項目が見つかりません' }, 404)
    const { count } = await supabase
      .from('work_manual_attachments')
      .select('id', { count: 'exact', head: true })
      .eq('manual_id', manualId)
    if ((count || 0) >= MAX_ATTACHMENTS) return json({ error: `添付ファイルは1項目${MAX_ATTACHMENTS}個までです` }, 400)

    const filename = (file.name || 'file').slice(0, 255)
    const ext = extOf(filename)
    const key = `${ATTACHMENT_PREFIX}${crypto.randomUUID()}${ext ? `.${ext}` : ''}`
    await putObject(key, file.stream(), file.type || 'application/octet-stream', { bucket: TEMPLATE_BUCKET })
    const { data, error: err } = await supabase
      .from('work_manual_attachments')
      .insert({ manual_id: manualId, filename, mime: file.type || null, file_size: file.size, storage_key: key, created_by: auth.sub })
      .select(ATTACHMENT_COLUMNS)
      .single()
    if (err) {
      await deleteObject(key, TEMPLATE_BUCKET)
      throw err
    }
    return json({ attachment: data })
  } catch (err) {
    console.error('manual-attachment-create 失敗:', err)
    return json({ error: '添付ファイルの保存に失敗しました' }, 500)
  }
}

// DELETE /api/manuals/attachments?id=… — 添付ファイルを1つ削除
export async function handleManualAttachmentDelete(req) {
  const { error } = await requireStaff(req)
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!UUID_RE.test(id)) return json({ error: 'id が不正です' }, 400)
    const supabase = getAdminClient()
    const { data: file } = await supabase.from('work_manual_attachments').select('storage_key').eq('id', id).maybeSingle()
    if (!file) return json({ error: '添付ファイルが見つかりません' }, 404)
    const { error: err } = await supabase.from('work_manual_attachments').delete().eq('id', id)
    if (err) throw err
    await deleteObject(file.storage_key, TEMPLATE_BUCKET).catch((e) =>
      console.error('manual-attachment-delete: ファイルの削除に失敗（孤児として残る可能性）:', file.storage_key, e)
    )
    return json({ ok: true })
  } catch (err) {
    console.error('manual-attachment-delete 失敗:', err)
    return json({ error: '添付ファイルの削除に失敗しました' }, 500)
  }
}

// POST /api/manuals/attachments/preview-token — アプリ内プレビュー（<iframe src>・<img src>）用の120秒だけ有効なトークン。
// 雛形ファイルのプレビューと同じ方式（worker/lib/documents.js の handleDocumentPreviewToken）
export async function handleManualAttachmentPreviewToken(req) {
  const { error } = await requireStaff(req)
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const id = typeof payload?.id === 'string' ? payload.id : ''
    if (!UUID_RE.test(id)) return json({ error: 'id が不正です' }, 400)
    const { SESSION_SECRET } = process.env
    if (!SESSION_SECRET) return json({ error: 'サーバー設定エラーが発生しました' }, 500)
    const token = await signJwt({ purpose: 'manual-attachment-preview', id }, SESSION_SECRET, PREVIEW_TTL_SECONDS)
    return json({ token })
  } catch (err) {
    console.error('manual-attachment-preview-token 失敗:', err)
    return json({ error: 'プレビュー用URLの発行に失敗しました' }, 500)
  }
}

// GET /api/manuals/attachments/download?id=…[&preview_token=…] — ファイル本体。
// preview_token が有効なら Bearer 認証の代わりにし、inline で返す（同じオリジンの iframe に埋め込める）
export async function handleManualAttachmentDownload(req) {
  const params = new URL(req.url).searchParams
  const id = params.get('id') || ''
  const previewToken = params.get('preview_token') || ''
  let viaPreviewToken = false
  if (previewToken) {
    const { SESSION_SECRET } = process.env
    const claims = SESSION_SECRET ? await verifyJwt(previewToken, SESSION_SECRET) : null
    viaPreviewToken = !!claims && claims.purpose === 'manual-attachment-preview' && claims.id === id
  }
  if (!viaPreviewToken) {
    const { error } = await requireStaff(req)
    if (error) return error
  }
  try {
    if (!UUID_RE.test(id)) return json({ error: 'id が不正です' }, 400)
    const { data: file } = await getAdminClient()
      .from('work_manual_attachments')
      .select('filename, mime, storage_key')
      .eq('id', id)
      .maybeSingle()
    if (!file) return json({ error: '添付ファイルが見つかりません' }, 404)
    const res = await getObject(file.storage_key, TEMPLATE_BUCKET)
    if (!res.ok) {
      console.error('manual-attachment-download: storage が', res.status, 'を返した')
      return json({ error: 'ファイルの取得に失敗しました' }, 404)
    }
    const asciiName = file.filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')
    const headers = {
      'Content-Type': file.mime || 'application/octet-stream',
      'Content-Disposition': `${viaPreviewToken ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'Cache-Control': viaPreviewToken ? 'private, no-store' : 'private, max-age=3600',
    }
    if (viaPreviewToken) {
      headers['X-Frame-Options'] = 'SAMEORIGIN'
      headers['Content-Security-Policy'] = "frame-ancestors 'self'"
    }
    return new Response(res.body, { status: 200, headers })
  } catch (err) {
    console.error('manual-attachment-download 失敗:', err)
    return json({ error: 'ファイルの取得に失敗しました' }, 500)
  }
}
