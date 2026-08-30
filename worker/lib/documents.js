// 雛形ファイル（業務で使う資料テンプレート）機能のAPIハンドラ（2026-08-30〜）。
// 「登録していつでもダウンロードできる資料置き場」で、日報等の業務データとは無関係の
// プロジェクト共通情報のため、このファイルに閉じて追加する。
// 権限: staff/admin は読み書き、owner・備品出庫限定ロールは閲覧・ダウンロードのみ
// （テナント様に配布する契約書式なども置く想定のため、他の閲覧専用画面と同じ扱いにする）。

import { json, verifyRequestAuth, canWrite } from './http.js'
import { getAdminClient } from './supabase-admin.js'
import { putObject, getObject, deleteObject, TEMPLATE_BUCKET } from './storage.js'
import { signJwt, verifyJwt } from './jwt.js'

const DOCUMENT_COLUMNS =
  'id, name, category, remark, original_filename, file_ext, file_size, file_modified_at, mime, ' +
  'pdf_original_filename, pdf_file_size, pdf_file_modified_at, created_at, updated_at'

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024 // 1ファイル20MB（帳票・様式集程度を想定）

// プレビュー表示用トークンの有効期限（秒）。Gmail添付・自主検査表PDFのプレビューと同じ短命設計
// （worker/index.js の handleAttachmentPreviewToken・worker/lib/reports.js 参照）
const DOCUMENT_PREVIEW_TTL_SECONDS = 120

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

// PDF版として受け付けてよいか。mime（ブラウザ報告値）は環境により空/不正確なことが
// あるため、拡張子でも判定する（プレビュー側のPDF判定と同じ考え方。DocumentTemplates.jsx参照）
function looksLikePdf(file) {
  return file?.type === 'application/pdf' || extOf(file?.name) === 'pdf'
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
// pdf_file（任意。2026-08-30追加）: 原本（Word/Excel等）とは別に、印刷用のPDF版を
// 同時に登録できる。あわせて pdf_modified_at も任意で送ってもらう
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
    const pdfFile = form.get('pdf_file')
    const pdfModifiedAtMs = Number(form.get('pdf_modified_at'))

    if (!name) return json({ error: '資料名称は必須です' }, 400)
    if (!category) return json({ error: '分類は必須です' }, 400)
    if (!file || typeof file === 'string') return json({ error: 'file は必須です' }, 400)
    if (file.size > MAX_UPLOAD_BYTES) return json({ error: 'ファイルが大きすぎます（20MBまで）' }, 413)
    const hasPdfFile = pdfFile && typeof pdfFile !== 'string'
    if (hasPdfFile) {
      if (pdfFile.size > MAX_UPLOAD_BYTES) return json({ error: 'PDFファイルが大きすぎます（20MBまで）' }, 413)
      if (!looksLikePdf(pdfFile)) return json({ error: 'PDF版はPDFファイル（拡張子.pdf）を選択してください' }, 400)
    }

    const originalFilename = file.name || 'file'
    const ext = extOf(originalFilename)
    const key = `${crypto.randomUUID()}${ext ? `.${ext}` : ''}`
    await putObject(key, file.stream(), file.type || 'application/octet-stream', { bucket: TEMPLATE_BUCKET })

    let pdfKey = null
    if (hasPdfFile) {
      pdfKey = `${crypto.randomUUID()}.pdf`
      await putObject(pdfKey, pdfFile.stream(), 'application/pdf', { bucket: TEMPLATE_BUCKET })
    }

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
      pdf_storage_key: pdfKey,
      pdf_original_filename: hasPdfFile ? (pdfFile.name || 'file.pdf').slice(0, 255) : null,
      pdf_file_size: hasPdfFile ? pdfFile.size : null,
      pdf_file_modified_at:
        hasPdfFile && Number.isFinite(pdfModifiedAtMs) && pdfModifiedAtMs > 0
          ? new Date(pdfModifiedAtMs).toISOString()
          : null,
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
      if (pdfKey) await deleteObject(pdfKey, TEMPLATE_BUCKET)
      console.error('document-create:', err.message)
      return json({ error: '雛形ファイルの登録に失敗しました' }, 500)
    }
    return json({ document: data })
  } catch (err) {
    console.error('document-create 失敗:', err)
    return json({ error: '雛形ファイルの登録に失敗しました' }, 500)
  }
}

// POST /api/documents/pdf — 既存の登録に、印刷用のPDF版を追加・差し替える
// （multipart/form-data。id・file必須、modified_at任意）。書き込み権限が必要。
export async function handleDocumentPdfAttach(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const form = await req.formData().catch(() => null)
    if (!form) return json({ error: 'ファイルの受け取りに失敗しました' }, 400)

    const id = String(form.get('id') || '')
    const file = form.get('file')
    const modifiedAtMs = Number(form.get('modified_at'))

    if (!id) return json({ error: 'id は必須です' }, 400)
    if (!file || typeof file === 'string') return json({ error: 'file は必須です' }, 400)
    if (file.size > MAX_UPLOAD_BYTES) return json({ error: 'ファイルが大きすぎます（20MBまで）' }, 413)
    if (!looksLikePdf(file)) return json({ error: 'PDFファイル（拡張子.pdf）を選択してください' }, 400)

    const supabase = getAdminClient()
    const { data: existing } = await supabase
      .from('document_templates')
      .select('pdf_storage_key')
      .eq('id', id)
      .maybeSingle()
    if (!existing) return json({ error: '雛形ファイルが見つかりません' }, 404)

    const key = `${crypto.randomUUID()}.pdf`
    await putObject(key, file.stream(), 'application/pdf', { bucket: TEMPLATE_BUCKET })

    const { data, error: err } = await supabase
      .from('document_templates')
      .update({
        pdf_storage_key: key,
        pdf_original_filename: (file.name || 'file.pdf').slice(0, 255),
        pdf_file_size: file.size,
        pdf_file_modified_at:
          Number.isFinite(modifiedAtMs) && modifiedAtMs > 0 ? new Date(modifiedAtMs).toISOString() : null,
      })
      .eq('id', id)
      .select(DOCUMENT_COLUMNS)
      .single()
    if (err) {
      await deleteObject(key, TEMPLATE_BUCKET)
      console.error('document-pdf-attach:', err.message)
      return json({ error: 'PDF版の登録に失敗しました' }, 500)
    }
    // 差し替えの場合は古いPDFオブジェクトを消して孤児を残さない
    if (existing.pdf_storage_key) await deleteObject(existing.pdf_storage_key, TEMPLATE_BUCKET)
    return json({ document: data })
  } catch (err) {
    console.error('document-pdf-attach 失敗:', err)
    return json({ error: 'PDF版の登録に失敗しました' }, 500)
  }
}

// DELETE /api/documents/pdf?id=… — PDF版だけを削除する（原本・登録自体は残す）
export async function handleDocumentPdfDelete(req) {
  const { error } = await requireAuth(req, { write: true })
  if (error) return error
  try {
    const id = new URL(req.url).searchParams.get('id') || ''
    if (!id) return json({ error: 'id は必須です' }, 400)

    const supabase = getAdminClient()
    const { data: existing } = await supabase
      .from('document_templates')
      .select('pdf_storage_key')
      .eq('id', id)
      .maybeSingle()
    if (!existing) return json({ error: '雛形ファイルが見つかりません' }, 404)
    if (!existing.pdf_storage_key) return json({ error: 'PDF版は登録されていません' }, 400)

    const { data, error: err } = await supabase
      .from('document_templates')
      .update({
        pdf_storage_key: null,
        pdf_original_filename: null,
        pdf_file_size: null,
        pdf_file_modified_at: null,
      })
      .eq('id', id)
      .select(DOCUMENT_COLUMNS)
      .single()
    if (err) {
      console.error('document-pdf-delete:', err.message)
      return json({ error: 'PDF版の削除に失敗しました' }, 500)
    }
    await deleteObject(existing.pdf_storage_key, TEMPLATE_BUCKET)
    return json({ document: data })
  } catch (err) {
    console.error('document-pdf-delete 失敗:', err)
    return json({ error: 'PDF版の削除に失敗しました' }, 500)
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
      .select('storage_key, pdf_storage_key')
      .eq('id', id)
      .maybeSingle()
    if (!doc) return json({ error: '雛形ファイルが見つかりません' }, 404)

    const { error: err } = await supabase.from('document_templates').delete().eq('id', id)
    if (err) {
      console.error('document-delete:', err.message)
      return json({ error: '雛形ファイルの削除に失敗しました' }, 500)
    }
    await deleteObject(doc.storage_key, TEMPLATE_BUCKET)
    if (doc.pdf_storage_key) await deleteObject(doc.pdf_storage_key, TEMPLATE_BUCKET)
    return json({ ok: true })
  } catch (err) {
    console.error('document-delete 失敗:', err)
    return json({ error: '雛形ファイルの削除に失敗しました' }, 500)
  }
}

// POST /api/documents/preview-token — アプリ内プレビュー（またはOS既定アプリでの
// 直接表示）用に、短時間（120秒）だけ有効な直接アクセストークンを発行する。
// ログイン必須（書き込み権限は不要。閲覧専用ロールでもプレビューはできる）。
// 通常の /api/documents/download はAuthorizationヘッダ必須だが、<iframe src>や
// 新規タブへの直接ナビゲーションではヘッダを送れないため、ここで発行する
// 短時間有効なトークンをクエリ文字列で代わりに使う（Gmail添付・自主検査表PDFの
// プレビューと同じ方式。worker/index.js の handleAttachmentPreviewToken 参照）。
// kind（任意。既定 'original'）: 'pdf' を指定すると原本ではなくPDF版のトークンを発行する
// （2026-08-30。原本とは別にPDF版を持てるようになったため）。
export async function handleDocumentPreviewToken(req) {
  const { error } = await requireAuth(req)
  if (error) return error
  try {
    const payload = await req.json().catch(() => null)
    const id = typeof payload?.id === 'string' ? payload.id : ''
    const kind = payload?.kind === 'pdf' ? 'pdf' : 'original'
    if (!id) return json({ error: 'id が必要です' }, 400)

    const supabase = getAdminClient()
    const { data: doc } = await supabase
      .from('document_templates')
      .select('id, pdf_storage_key')
      .eq('id', id)
      .maybeSingle()
    if (!doc) return json({ error: '雛形ファイルが見つかりません' }, 404)
    if (kind === 'pdf' && !doc.pdf_storage_key) return json({ error: 'PDF版は登録されていません' }, 404)

    const { SESSION_SECRET } = process.env
    if (!SESSION_SECRET) {
      console.error('document-preview-token: SESSION_SECRET が設定されていません')
      return json({ error: 'サーバー設定エラーが発生しました' }, 500)
    }
    const token = await signJwt(
      { purpose: 'document-preview', id, kind },
      SESSION_SECRET,
      DOCUMENT_PREVIEW_TTL_SECONDS
    )
    return json({ token })
  } catch (err) {
    console.error('document-preview-token 失敗:', err)
    return json({ error: 'プレビュー用URLの発行に失敗しました' }, 500)
  }
}

// GET /api/documents/download?id=…[&kind=pdf][&preview_token=…] — ファイル本体を返す。
// kind（任意。既定 'original'）で原本／PDF版のどちらを返すか選べる。
// preview_token（上記handleDocumentPreviewTokenが発行）が有効かつ対象のid・kindと
// 一致する場合は、通常のBearer認証の代わりとして受け付け、Content-Dispositionを
// inlineにする（ブラウザ・OSが既定のビューアでそのまま開けるようにするため。
// 通常のダウンロードはattachmentのまま）。
export async function handleDocumentDownload(req) {
  const params = new URL(req.url).searchParams
  const id = params.get('id') || ''
  const kind = params.get('kind') === 'pdf' ? 'pdf' : 'original'
  const previewToken = params.get('preview_token') || ''

  let viaPreviewToken = false
  if (previewToken) {
    const { SESSION_SECRET } = process.env
    const claims = SESSION_SECRET ? await verifyJwt(previewToken, SESSION_SECRET) : null
    viaPreviewToken =
      !!claims && claims.purpose === 'document-preview' && claims.id === id && claims.kind === kind
  }
  if (!viaPreviewToken) {
    const { error } = await requireAuth(req)
    if (error) return error
  }

  try {
    if (!id) return json({ error: 'id は必須です' }, 400)

    const supabase = getAdminClient()
    const { data: doc } = await supabase
      .from('document_templates')
      .select('storage_key, mime, original_filename, pdf_storage_key, pdf_original_filename')
      .eq('id', id)
      .maybeSingle()
    if (!doc) return json({ error: '雛形ファイルが見つかりません' }, 404)

    const storageKey = kind === 'pdf' ? doc.pdf_storage_key : doc.storage_key
    if (!storageKey) return json({ error: kind === 'pdf' ? 'PDF版は登録されていません' : 'ファイルが見つかりません' }, 404)
    const mimeType = kind === 'pdf' ? 'application/pdf' : doc.mime || 'application/octet-stream'
    const filename = (kind === 'pdf' ? doc.pdf_original_filename : doc.original_filename) || 'file'

    const res = await getObject(storageKey, TEMPLATE_BUCKET)
    if (!res.ok) {
      console.error('document-download: storage が', res.status, 'を返した')
      return json({ error: 'ファイルの取得に失敗しました' }, 404)
    }
    const asciiName = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')
    const encodedName = encodeURIComponent(filename)
    const disposition = viaPreviewToken ? 'inline' : 'attachment'
    const headers = {
      'Content-Type': mimeType,
      'Content-Disposition': `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
      'Cache-Control': viaPreviewToken ? 'private, no-store' : 'private, max-age=3600',
    }
    // preview_token経由のときだけ、このレスポンスを同一オリジンの<iframe>に埋め込める
    // ようにする（handleDownloadAttachmentと同じ理由。worker/index.js参照）
    if (viaPreviewToken) {
      headers['X-Frame-Options'] = 'SAMEORIGIN'
      headers['Content-Security-Policy'] = "frame-ancestors 'self'"
    }
    return new Response(res.body, { status: 200, headers })
  } catch (err) {
    console.error('document-download 失敗:', err)
    return json({ error: 'ファイルの取得に失敗しました' }, 500)
  }
}
