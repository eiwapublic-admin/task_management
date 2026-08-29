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

// file: ブラウザの File オブジェクト（input[type=file]）。物理ファイル名・拡張子・
// サイズ・最終更新日時はここから自動で取り、サーバー側では改めて解釈しない
export async function createDocument({ name, category, remark, file }) {
  const form = new FormData()
  form.append('name', name)
  form.append('category', category)
  if (remark) form.append('remark', remark)
  form.append('file', file, file.name)
  // File.lastModified はOS側のファイル最終更新日時（epoch ms）。multipart自体には
  // 運ぶ仕組みが無いため、ブラウザで読めるこの値を別フィールドとして送る
  form.append('modified_at', String(file.lastModified || ''))

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 45000)
  let res
  try {
    res = await fetch('/api/documents', {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}` },
      body: form,
      signal: controller.signal,
    })
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('ファイルのアップロードがタイムアウトしました。通信環境をご確認のうえ再度お試しください。')
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || '雛形ファイルの登録に失敗しました')
  return data.document
}

export async function deleteDocument(id) {
  await authFetch(`/api/documents?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ダウンロードは<iframe>や<a>から直接叩けないため（Authorizationヘッダが送れない）、
// blobとして取得してから保存する（自主検査表PDFの共有/保存と同じ考え方）
export async function downloadDocument(id, filename) {
  const res = await fetch(`/api/documents/download?id=${encodeURIComponent(id)}`, {
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
