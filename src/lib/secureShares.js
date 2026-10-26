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
// 送り先は連絡帳の id で渡す（名前・アドレス・携帯番号はサーバーが連絡帳から引き直す）
export async function createSecureShare({ pdfBlob, filename, title, contactId, days, maxOpens, draft }) {
  const form = new FormData()
  form.append('pdf', pdfBlob, filename)
  form.append('title', title)
  form.append('contact_id', contactId)
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

// 連絡帳のうち、安全なリンクの送り先に選べるもの（携帯電話番号とメールアドレスの両方があるもの。2026-10-26 依頼）
export function shareableContacts(contacts) {
  return (contacts || []).filter((c) => (c.mobile_phone || '').trim() && (c.email_to || '').trim())
}

export function contactLabel(c) {
  return [c.company_name, c.contact_person].map((v) => (v || '').trim()).filter(Boolean).join(' ')
}

// パスコードを伝える SMS（ショートメッセージ）の文面と、端末の SMS アプリを開く sms: リンク（2026-10-26 依頼）。
// 送信はしない（自動送信は有料サービスが要るため）。スマホなら SMS アプリが宛先・本文入りで開く。
// 「?&body=」は iPhone（&body=）と Android（?body=）のどちらでも本文が入る書き方。
// 受け取る側には「パスワード」と伝える（文面は依頼元の指定。2026-10-26）
export function passcodeSmsText(title, passcode) {
  return `別途メールでご案内しました「${title}」をダウンロードするためのパスワードのご連絡です。\nパスワードは${passcode}です。ダウンロード画面にてご入力ください。`
}

export function smsHref(mobile, body) {
  const number = String(mobile || '')
    .normalize('NFKC')
    .replace(/[^\d+]/g, '')
  return `sms:${number}?&body=${encodeURIComponent(body)}`
}

export function buildPasscodeSms({ mobile, title, passcode }) {
  const body = passcodeSmsText(title, passcode)
  return { body, href: smsHref(mobile, body) }
}
