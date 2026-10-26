import { authFetch } from './api'
import { getToken } from './auth'

// 安全なリンクで共有（2026-10-26〜。サーバーは worker/lib/secure-shares.js）。
// PDF を非公開の保管場所に置き、期限付き・パスコード付きのリンクで相手に渡す

export const SHARE_DEFAULT_DAYS = 15
export const SHARE_DEFAULT_OPENS = 5
export const SHARE_MAX_DAYS = 90
export const SHARE_MAX_OPENS = 50

export const SHARE_STATUS = {
  active: { label: '有効', badge: 'is-current' },
  used_up: { label: '回数切れ', badge: '' },
  expired: { label: '期限切れ', badge: '' },
  locked: { label: '停止中（パスコード誤り）', badge: 'is-danger' },
  revoked: { label: '取り消し済み', badge: '' },
  deleted: { label: 'ファイル削除済み', badge: '' },
}

export const SHARE_LOG_RESULT = {
  opened: '開いた',
  wrong_passcode: 'パスコード誤り',
  expired: '期限切れで開けず',
  revoked: '取り消し後に開こうとした',
  locked: '停止中に開こうとした',
  used_up: '回数切れで開けず',
  deleted: 'ファイル削除後に開こうとした',
}

// 共有を作る。戻り値: { share, url, passcode, draft_url?, draft_error? }
export async function createSecureShare({ pdfBlob, filename, title, recipientName, recipientEmail, days, maxOpens, draft }) {
  const form = new FormData()
  form.append('pdf', pdfBlob, filename)
  form.append('title', title)
  form.append('recipient_name', recipientName)
  form.append('recipient_email', recipientEmail || '')
  form.append('days', String(days))
  form.append('max_opens', String(maxOpens))
  form.append('draft', draft ? '1' : '0')
  const controller = new AbortController()
  // PDF のアップロード＋Gmail の下書き作成で数秒〜十数秒かかる。電波の悪い場所で固まらないよう打ち切る
  const timeoutId = setTimeout(() => controller.abort(), 60000)
  let res
  try {
    res = await fetch('/api/secure-shares', {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}` },
      body: form,
      signal: controller.signal,
    })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('共有の作成がタイムアウトしました。通信環境をご確認のうえ再度お試しください。')
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `共有の作成に失敗しました (${res.status})`)
  return data
}

export function fetchSecureShares() {
  return authFetch('/api/secure-shares')
}

export function revokeSecureShare(id) {
  return authFetch('/api/secure-shares', { method: 'PATCH', body: JSON.stringify({ id, action: 'revoke' }) })
}

// パスコードを作り直す（止まったリンクも再び使えるようになる）。戻り値: { share, passcode }
export function reissueSecureSharePasscode(id) {
  return authFetch('/api/secure-shares', { method: 'PATCH', body: JSON.stringify({ id, action: 'reissue' }) })
}

// クリップボードへコピーする（使えない端末では false を返す。呼び出し側で「長押しでコピー」を案内する）
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function formatShareDateTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}
