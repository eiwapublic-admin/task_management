// 雛形ファイル（業務で使う資料テンプレート）のフロントエンド API クライアント（2026-08-30〜）。
// 日報等の業務データとは無関係のプロジェクト共通情報のため、reports.js とは分けて置く。

import { authFetch } from './api'
import { getToken } from './auth'

export async function fetchDocuments() {
  const data = await authFetch('/api/documents')
  return data.documents || []
}

// 登録済みの分類（重複除く。既存データからの選択式にするため）
export async function fetchDocumentCategories() {
  const data = await authFetch('/api/documents/suggest')
  return data.values || []
}

// createDocument・attachDocumentPdf・attachDocumentOriginal はいずれも
// 「multipart/form-dataをPOSTし、タイムアウト付きで結果のdocumentを受け取る」形が共通のため、
// ここに1本化する（timeoutMessage/failureMessageだけ呼び出し側で変える）
async function postMultipart(url, form, { timeoutMessage, failureMessage }) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 45000)
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
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

// file: ブラウザの File オブジェクト（input[type=file]）。物理ファイル名・拡張子・
// サイズ・最終更新日時はここから自動で取り、サーバー側では改めて解釈しない。
// pdfFile（任意。2026-08-30追加）: 原本（Word/Excel等）とは別に、印刷用のPDF版を
// 同時に登録したい場合に渡す
export async function createDocument({ name, category, remark, file, pdfFile }) {
  const form = new FormData()
  form.append('name', name)
  form.append('category', category)
  if (remark) form.append('remark', remark)
  form.append('file', file, file.name)
  // File.lastModified はOS側のファイル最終更新日時（epoch ms）。multipart自体には
  // 運ぶ仕組みが無いため、ブラウザで読めるこの値を別フィールドとして送る
  form.append('modified_at', String(file.lastModified || ''))
  if (pdfFile) {
    form.append('pdf_file', pdfFile, pdfFile.name)
    form.append('pdf_modified_at', String(pdfFile.lastModified || ''))
  }
  return postMultipart('/api/documents', form, {
    timeoutMessage: 'ファイルのアップロードがタイムアウトしました。通信環境をご確認のうえ再度お試しください。',
    failureMessage: '雛形ファイルの登録に失敗しました',
  })
}

// 登録済みの雛形ファイルへ、印刷用のPDF版を追加・差し替える（2026-08-30追加）。
// 原本がWord/Excel等の場合、ユーザーが自分の環境でPDFに変換してから登録する運用を想定
// （サーバー側でのOffice文書→PDF変換は行わない）。
export async function attachDocumentPdf(id, file) {
  const form = new FormData()
  form.append('id', id)
  form.append('file', file, file.name)
  form.append('modified_at', String(file.lastModified || ''))
  return postMultipart('/api/documents/pdf', form, {
    timeoutMessage: 'PDFのアップロードがタイムアウトしました。通信環境をご確認のうえ再度お試しください。',
    failureMessage: 'PDF版の登録に失敗しました',
  })
}

// 登録済みの雛形ファイルの原本を差し替える（2026-08-30追加）。PDF版とは異なり
// 形式は問わない（原本はもともとWord/Excel/PDF等どれでも良いため）
export async function attachDocumentOriginal(id, file) {
  const form = new FormData()
  form.append('id', id)
  form.append('file', file, file.name)
  form.append('modified_at', String(file.lastModified || ''))
  return postMultipart('/api/documents/original', form, {
    timeoutMessage: 'ファイルのアップロードがタイムアウトしました。通信環境をご確認のうえ再度お試しください。',
    failureMessage: '原本の差し替えに失敗しました',
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
