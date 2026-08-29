// 雛形ファイル（業務で使う資料テンプレート）機能のAPIハンドラ（2026-08-30〜）。
// 「登録していつでもダウンロードできる資料置き場」で、日報等の業務データとは無関係の
// プロジェクト共通情報のため、このファイルに閉じて追加する。
// 権限: staff/admin は読み書き、owner・備品出庫限定ロールは閲覧・ダウンロードのみ
// （テナント様に配布する契約書式なども置く想定のため、他の閲覧専用画面と同じ扱いにする）。

import { json, verifyRequestAuth, canWrite } from './http.js'
import { getAdminClient } from './supabase-admin.js'
import { putObject, getObject, deleteObject, TEMPLATE_BUCKET } from './storage.js'

const DOCUMENT_COLUMNS =
  'id, name, category, remark, original_filename, file_ext, file_size, file_modified_at, mime, created_at, updated_at'

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024 // 1ファイル20MB（帳票・様式集程度を想定）

async function requireAuth(req, { write = false } = {}) {
  const auth = await verifyRequestAuth(req)
  if (!auth) return { error: json({ error: '認証が必要です' }, 401) }
  if (write && !canWrite(auth)) {
    return { error: json({ error: 'この操作を行う権限がありません' }, 403) }
  }
  return { auth }
}

// ファイル名から拡張子を取る（ドット無し・小文字）。無ければ空文字
function extOf(filename) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(filename || '')
  return m ? m[1].toLowerCase() : ''
}

// GET /api/documents — 一覧（分類→資料名称の順。並び替え自体は画面側でも行うが、
// 一覧取得の時点である程度揃えておく）
export async function handleDocumentList(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('document_templates')
      .select(DOCUMENT_COLUMNS)
      .order('category', { ascending: true })
      .order('name', { ascending: true })
    if (err) {
      console.error('document-list:', err.message)
      return json({ error: '雛形ファイルの取得に失敗しました' }, 500)
    }
    return json({ documents: data || [] })
  } catch (err) {
    console.error('document-list 失敗:', err)
    return json({ error: '雛形ファイルの取得に失敗しました' }, 500)
  }
}

// GET /api/documents/suggest — 登録済みの分類（重複除く。直近登録が先頭）。
// 備品の担当者/場所/調達先サジェストと同じ考え方（worker/lib/equipment.js 参照）
export async function handleDocumentCategorySuggest(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const supabase = getAdminClient()
    const { data, error: err } = await supabase
      .from('document_templates')
      .select('category')
      .order('created_at', { ascending: false })
      .limit(500)
    if (err) {
      console.error('document-category-suggest:', err.message)
      return json({ error: '分類の取得に失敗しました' }, 500)
    }
    const seen = new Map()
    for (const r of data || []) {
      if (r.category && !seen.has(r.category)) seen.set(r.category, seen.size)
    }
    return json({ values: [...seen.keys()].slice(0, 50) })
  } catch (err) {
    console.error('document-category-suggest 失敗:', err)
    return json({ error: '分類の取得に失敗しました' }, 500)
  }
}

// POST /api/documents — 登録（multipart/form-data）。
// 物理ファイル名・拡張子・サイズはアップロードされたファイルそのものから取る。
// 最終更新日付はブラウザのファイル選択時に読めるOS側のメタ情報（File.lastModified）を
// modified_at（epoch ms）として別フィールドで送ってもらう
// （multipart自体にはファイルの更新日時を運ぶ仕組みが無いため）。
export async function handleDocumentCreate(req) {
  const { auth, error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const form = await req.formData().catch(() => null)
    if (!form) return json({ error: 'ファイルの受け取りに失敗しました' }, 400)

    const name = String(form.get('name') || '').trim().slice(0, 200)
    const category = String(form.get('category') || '').trim().slice(0, 100)
    const remark = String(form.get('remark') || '').trim().slice(0, 500) || null
    const modifiedAtMs = Number(form.get('modified_at'))
    const file = form.get('file')

    if (!name) return json({ error: '資料名称は必須です' }, 400)
    if (!category) return json({ error: '分類は必須です' }, 400)
    if (!file || typeof file === 'string') return json({ error: 'file は必須です' }, 400)
    if (file.size > MAX_UPLOAD_BYTES) return json({ error: 'ファイルが大きすぎます（20MBまで）' }, 413)

    const originalFilename = file.name || 'file'
    const ext = extOf(originalFilename)
    const key = `${crypto.randomUUID()}${ext ? `.${ext}` : ''}`
    await putObject(key, file.stream(), file.type || 'application/octet-stream', { bucket: TEMPLATE_BUCKET })

    const supabase = getAdminClient()
    const row = {
      name,
      category,
      remark,
      original_filename: originalFilename.slice(0, 255),
      file_ext: ext || null,
      file_size: file.size,
      file_modified_at:
        Number.isFinite(modifiedAtMs) && modifiedAtMs > 0 ? new Date(modifiedAtMs).toISOString() : null,
      mime: file.type || null,
      storage_key: key,
      created_by: auth.sub,
    }
    const { data, error: err } = await supabase
      .from('document_templates')
      .insert(row)
      .select(DOCUMENT_COLUMNS)
      .single()
    if (err) {
      // DB に入らなかった場合は保管したオブジェクトを消して孤児を残さない
      await deleteObject(key, TEMPLATE_BUCKET)
      console.error('document-create:', err.message)
      return json({ error: '雛形ファイルの登録に失敗しました' }, 500)
    }
    return json({ document: data })
  } catch (err) {
    console.error('document-create 失敗:', err)
    return json({ error: '雛形ファイルの登録に失敗しました' }, 500)
  }
}

// DELETE /api/documents?id=…
export async function handleDocumentDelete(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!id) return json({ error: 'id は必須です' }, 400)

    const supabase = getAdminClient()
    const { data: doc } = await supabase
      .from('document_templates')
      .select('storage_key')
      .eq('id', id)
      .maybeSingle()
    if (!doc) return json({ error: '雛形ファイルが見つかりません' }, 404)

    const { error: err } = await supabase.from('document_templates').delete().eq('id', id)
    if (err) {
      console.error('document-delete:', err.message)
      return json({ error: '雛形ファイルの削除に失敗しました' }, 500)
    }
    await deleteObject(doc.storage_key, TEMPLATE_BUCKET)
    return json({ ok: true })
  } catch (err) {
    console.error('document-delete 失敗:', err)
    return json({ error: '雛形ファイルの削除に失敗しました' }, 500)
  }
}

// GET /api/documents/download?id=… — ファイル本体をダウンロード用に返す
export async function handleDocumentDownload(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!id) return json({ error: 'id は必須です' }, 400)

    const supabase = getAdminClient()
    const { data: doc } = await supabase
      .from('document_templates')
      .select('storage_key, mime, original_filename')
      .eq('id', id)
      .maybeSingle()
    if (!doc) return json({ error: '雛形ファイルが見つかりません' }, 404)

    const res = await getObject(doc.storage_key, TEMPLATE_BUCKET)
    if (!res.ok) {
      console.error('document-download: storage が', res.status, 'を返した')
      return json({ error: 'ファイルの取得に失敗しました' }, 404)
    }
    const filename = doc.original_filename || 'file'
    const asciiName = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')
    const encodedName = encodeURIComponent(filename)
    return new Response(res.body, {
      status: 200,
      headers: {
        'Content-Type': doc.mime || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch (err) {
    console.error('document-download 失敗:', err)
    return json({ error: 'ファイルの取得に失敗しました' }, 500)
  }
}
