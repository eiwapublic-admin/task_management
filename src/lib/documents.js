// 雛形ファイル（業務で使う資料テンプレート）のフロントエンド API クライアント（2026-08-30〜）。
// 日報等の業務データとは無関係のプロジェクト共通情報のため、reports.js とは分けて置く。

import { authFetch } from './api'
import { getToken } from './auth'

export async function fetchDocuments() {
  const data = await authFetch('/api/documents')
  return data.documents || []
}

// このドキュメントで「プレビュー可能なPDF」として扱えるものを1つ求める（2026-08-30追加）。
// 優先順位: 別登録されたPDF版 > 原本自体がPDFの場合はその原本。どちらも無ければnull
// （原本がWord/Excel等でPDF版も未登録の場合。一覧では「未登録」表示になる）
export function getEffectivePdf(doc) {
  if (doc.pdf_original_filename) {
    return { kind: 'pdf', filename: doc.pdf_original_filename, hasOwnInfo: true }
  }
  const ext = (doc.file_ext || '').toLowerCase()
  if (doc.mime === 'application/pdf' || ext === 'pdf') {
    return { kind: 'original', filename: doc.original_filename, hasOwnInfo: false }
  }
  return null
}

// 登録済みの分類（重複除く。既存データからの選択式にするため）
export async function fetchDocumentCategories() {
  const data = await authFetch('/api/documents/suggest')
  return data.values || []
}

// createDocument・updateDocument はいずれも「multipart/form-dataを送信し、タイムアウト付きで
// 結果のdocumentを受け取る」形が共通のため、ここに1本化する
// （method/timeoutMessage/failureMessageだけ呼び出し側で変える）
async function submitMultipart(url, method, form, { timeoutMessage, failureMessage }) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 45000)
  let res
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${getToken()}` },
      body: form,
      signal: controller.signal,
    })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(timeoutMessage)
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || failureMessage)
  return data.document
}

// 資料名称・分類・備考・原本・PDF版・サムネイルをフォームに積む共通処理
// （createDocument・updateDocument で共通のため1本化する）。
// file: ブラウザの File オブジェクト（input[type=file]）。物理ファイル名・拡張子・
// サイズ・最終更新日時はここから自動で取り、サーバー側では改めて解釈しない。
// pdfFile（任意）: 原本（Word/Excel等）とは別に、印刷用のPDF版を同時に登録したい場合に渡す。
// thumbnail（任意）: 一覧のカードに出すサムネイル画像（ブラウザ側で縮小済みのBlob/File。
// 常にJPEGとして送る）
function buildDocumentForm({ name, category, remark, file, pdfFile, thumbnail }) {
  const form = new FormData()
  form.append('name', name)
  form.append('category', category)
  if (remark) form.append('remark', remark)
  if (file) {
    form.append('file', file, file.name)
    // File.lastModified はOS側のファイル最終更新日時（epoch ms）。multipart自体には
    // 運ぶ仕組みが無いため、ブラウザで読めるこの値を別フィールドとして送る
    form.append('modified_at', String(file.lastModified || ''))
  }
  if (pdfFile) {
    form.append('pdf_file', pdfFile, pdfFile.name)
    form.append('pdf_modified_at', String(pdfFile.lastModified || ''))
  }
  if (thumbnail) {
    form.append('thumbnail', thumbnail, 'thumbnail.jpg')
  }
  return form
}

export async function createDocument({ name, category, remark, file, pdfFile, thumbnail }) {
  const form = buildDocumentForm({ name, category, remark, file, pdfFile, thumbnail })
  return submitMultipart('/api/documents', 'POST', form, {
    timeoutMessage: 'ファイルのアップロードがタイムアウトしました。通信環境をご確認のうえ再度お試しください。',
    failureMessage: '雛形ファイルの登録に失敗しました',
  })
}

// 既存の雛形ファイルを更新する（2026-08-31追加。新規登録と同じ画面で編集も行うため、
// 名称・分類・備考は常に送り、原本・PDF版・サムネイルは差し替える分だけ渡す
// （file/pdfFile/thumbnailを省略すればそれぞれ既存のまま）
export async function updateDocument(id, { name, category, remark, file, pdfFile, thumbnail }) {
  const form = buildDocumentForm({ name, category, remark, file, pdfFile, thumbnail })
  form.append('id', id)
  return submitMultipart('/api/documents', 'PUT', form, {
    timeoutMessage: 'ファイルのアップロードがタイムアウトしました。通信環境をご確認のうえ再度お試しください。',
    failureMessage: '雛形ファイルの更新に失敗しました',
  })
}

// PDF版だけを削除する（原本・登録自体は残す）
export async function deleteDocumentPdf(id) {
  const data = await authFetch(`/api/documents/pdf?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
  return data.document
}

// アプリ内プレビュー（またはOS既定アプリでの直接表示）用に、短時間（120秒）だけ有効な
// 直接アクセスURLを発行する（/api/documents/preview-token）。<iframe src>や新規タブへの
// 直接ナビゲーションはAuthorizationヘッダを送れないため、発行したトークンをクエリ文字列で
// 代わりに使う（自主検査表PDF・Gmail添付のプレビューと同じ方式。src/lib/api.js の
// getAttachmentPreviewUrl 参照）。
// kind（既定 'original'）: 'pdf' を指定すると原本ではなくPDF版のURLを発行する
export async function getDocumentPreviewUrl(id, kind = 'original') {
  const { token } = await authFetch('/api/documents/preview-token', {
    method: 'POST',
    body: JSON.stringify({ id, kind }),
  })
  const params = new URLSearchParams({ id, kind, preview_token: token })
  return `/api/documents/download?${params.toString()}`
}

export async function deleteDocument(id) {
  await authFetch(`/api/documents?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// サムネイル画像を取得して Blob URL を作る（2026-08-31追加。一覧のカード表示用）。
// バケットは非公開なので必ずこの経路を通す（日報写真の fetchPhotoObjectUrl と同じ考え方）。
// 呼び出し側は使い終わったら URL.revokeObjectURL で解放すること
export async function fetchDocumentThumbnailUrl(id) {
  const res = await fetch(`/api/documents/thumbnail?id=${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  })
  if (!res.ok) throw new Error('サムネイルを取得できませんでした')
  return URL.createObjectURL(await res.blob())
}

// ダウンロードは<iframe>や<a>から直接叩けないため（Authorizationヘッダが送れない）、
// blobとして取得してから保存する（自主検査表PDFの共有/保存と同じ考え方）。
// kind（既定 'original'）で原本／PDF版のどちらをダウンロードするか選べる
export async function downloadDocument(id, filename, kind = 'original') {
  const params = new URLSearchParams({ id, kind })
  const res = await fetch(`/api/documents/download?${params.toString()}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || 'ファイルの取得に失敗しました')
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename || 'file'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
