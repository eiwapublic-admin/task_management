import { authFetch } from './api'
import { getToken } from './auth'

// 業務マニュアル（日常業務の手引書。2026-10-13〜）の API 呼び出しと、種類ごとの項目定義。
// 種類と項目は worker/lib/manuals.js の MANUAL_FIELDS と揃えること。

// 分類（2026-10-13 の依頼で2つに整理）。旧「対応マニュアル」＝対応方法、旧「関連手順」は定例作業へ統合した。
// tone は一覧・修正画面のラベルの色（Manuals.css の .manuals-kind-label.is-xxx）
export const MANUAL_KINDS = [
  { key: 'response', label: '対応方法', titleLabel: '依頼・問い合わせ例', tone: 'response' },
  { key: 'routine', label: '定例作業', titleLabel: '作業名', tone: 'routine' },
]

export const MANUAL_KIND_LABELS = Object.fromEntries(MANUAL_KINDS.map((k) => [k.key, k.label]))

// 画面に出す順の項目。手順の本文（body）はどちらの分類でも持てる（「手順」として最後に出す）
export const MANUAL_FIELD_DEFS = {
  response: [
    { key: 'method', label: '対応方法' },
    { key: 'contact', label: '連絡先' },
    { key: 'note', label: '留意事項' },
  ],
  routine: [
    { key: 'timing', label: 'タイミング' },
    { key: 'items', label: '持ち物・準備' },
    { key: 'place', label: '作業場所' },
    { key: 'content', label: '作業内容' },
    { key: 'after', label: '事後' },
    { key: 'remark', label: '備考' },
  ],
}

// 修正画面で分類を変えたときに、中身を近い項目へ移す（対応方法⇔作業内容、留意事項⇔備考。
// 連絡先は定例作業に対応する欄が無いので備考の末尾に「連絡先: 」を付けて残す）。移し先が空でなければ改行でつなぐ
export function convertManualFields(fields, from, to) {
  if (from === to) return { ...fields }
  const out = {}
  const put = (key, value) => {
    if (!value) return
    out[key] = out[key] ? `${out[key]}\n${value}` : value
  }
  if (from === 'response' && to === 'routine') {
    put('content', fields.method)
    put('remark', fields.note)
    if (fields.contact) put('remark', `連絡先: ${fields.contact}`)
  } else if (from === 'routine' && to === 'response') {
    put('method', fields.content)
    put('note', fields.remark)
    for (const [key, label] of [['timing', 'タイミング'], ['items', '持ち物・準備'], ['place', '作業場所'], ['after', '事後']]) {
      if (fields[key]) put('note', `${label}: ${fields[key]}`)
    }
  }
  return out
}

// キーワード検索の対象になる文字列（項目名・各項目・本文・添付ファイル名をつないだもの）
export function manualSearchText(m) {
  return [m.title, ...Object.values(m.fields || {}), m.body || '', ...(m.attachments || []).map((a) => a.filename)]
    .join('\n')
    .toLowerCase()
}

export async function fetchManuals() {
  const data = await authFetch('/api/manuals')
  return data.manuals || []
}

export async function createManual(payload) {
  const data = await authFetch('/api/manuals', { method: 'POST', body: JSON.stringify(payload) })
  return data.manual
}

export async function updateManual(id, payload) {
  const data = await authFetch('/api/manuals', { method: 'PATCH', body: JSON.stringify({ id, ...payload }) })
  return data.manual
}

export async function deleteManual(id) {
  await authFetch(`/api/manuals?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// --- 添付ファイル（2026-10-26〜。worker/lib/manuals.js。1ファイル20MB・1項目20個まで） ---
export const MANUAL_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024

export async function uploadManualAttachment(manualId, file) {
  const form = new FormData()
  form.append('manual_id', manualId)
  form.append('file', file, file.name)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 60000)
  let res
  try {
    res = await fetch('/api/manuals/attachments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}` },
      body: form,
      signal: controller.signal,
    })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`「${file.name}」のアップロードがタイムアウトしました。通信環境をご確認のうえ再度お試しください`)
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `「${file.name}」の保存に失敗しました`)
  return data.attachment
}

export async function deleteManualAttachment(id) {
  await authFetch(`/api/manuals/attachments?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// アプリ内でプレビューできるか（画像・PDF）
export function canPreviewAttachment(a) {
  const mime = a.mime || ''
  return mime.startsWith('image/') || mime === 'application/pdf' || /\.pdf$/i.test(a.filename)
}

// プレビュー用の直接アクセス URL（120秒有効。<iframe src> は Authorization ヘッダを送れないため）
export async function getManualAttachmentPreviewUrl(id) {
  const { token } = await authFetch('/api/manuals/attachments/preview-token', { method: 'POST', body: JSON.stringify({ id }) })
  return `/api/manuals/attachments/download?${new URLSearchParams({ id, preview_token: token })}`
}

export async function downloadManualAttachment(a) {
  const res = await fetch(`/api/manuals/attachments/download?id=${encodeURIComponent(a.id)}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || 'ファイルの取得に失敗しました')
  }
  const url = URL.createObjectURL(await res.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = a.filename || 'file'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export function formatFileSize(bytes) {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
