// 安全なリンクで共有（2026-10-26〜）。個人情報を含む書類（緊急連絡先一覧表など）を、メールに添付せずに
// 顧客・オーナーへ渡すための仕組み。
//   ・PDF は Storage の非公開バケット secure-shares に置き、公開 URL は作らない（取り出せるのは Worker だけ）
//   ・相手に渡すのは /s/<推測できない長い文字列> のリンク。開くには6桁のパスコードが要る
//     （パスコードは電話など、メール以外の方法で伝える運用）
//   ・有効期限（既定15日）と開ける回数（既定5回）。パスコードを5回間違えるとそのリンクは止まる
//   ・送った後でも取り消せる。開いた・間違えた記録は secure_share_access_log に残る
//   ・期限切れ・取り消し・回数を使い切ったものは、毎日の定期処理（3時）で PDF を消す（記録の行は残す）
// リンクの文字列とパスコードは DB にそのまま残さない（リンクは SHA-256、パスコードは SESSION_SECRET を鍵にした
// HMAC）。そのため作成した直後の画面でしか見られない。パスコードを忘れたら一覧から「パスコードを再発行」する。

import { json, verifyRequestAuth, canWrite } from './http.js'
import { getAdminClient } from './supabase-admin.js'
import { putObject, getObject, deleteObject, deleteObjects } from './storage.js'
import { getAccessToken, createDraft } from './gmail.js'
import { buildMimeMessage } from './mime.js'

export const SHARE_BUCKET = 'secure-shares'
export const SHARE_DEFAULT_DAYS = 15
export const SHARE_DEFAULT_OPENS = 5
const SHARE_MAX_DAYS = 90
const SHARE_MAX_OPENS = 50
const MAX_FAILED = 5
const PDF_MAX_BYTES = 20 * 1024 * 1024
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/

const LIST_COLUMNS =
  'id, title, filename, size_bytes, contact_id, recipient_name, recipient_email, recipient_mobile, expires_at, max_opens, open_count, failed_attempts, locked_at, revoked_at, file_deleted_at, last_opened_at, created_by, created_at'

async function requireStaff(req) {
  const auth = await verifyRequestAuth(req)
  if (!auth) return { error: json({ error: '認証が必要です' }, 401) }
  if (!canWrite(auth)) return { error: json({ error: 'この画面を使う権限がありません' }, 403) }
  return { auth }
}

const actorOf = (auth) => (auth?.display_name || auth?.username || '社員').slice(0, 100)

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function intIn(value, def, min, max) {
  if (value == null || value === '') return def
  const n = Number(value)
  if (!Number.isInteger(n)) return def
  return Math.min(max, Math.max(min, n))
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// リンクの文字列（32バイトの乱数 → base64url で43字）
function newToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

// 6桁のパスコード（偏りが出ないよう、100万の倍数に収まらない値は引き直す）
function newPasscode() {
  const limit = Math.floor(0x100000000 / 1000000) * 1000000
  for (;;) {
    const [n] = crypto.getRandomValues(new Uint32Array(1))
    if (n < limit) return String(n % 1000000).padStart(6, '0')
  }
}

async function sha256Hex(value) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

async function passcodeHash(shareId, passcode) {
  const secret = process.env.SESSION_SECRET
  if (!secret) throw new Error('SESSION_SECRET が設定されていません')
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`secure-share:${shareId}:${passcode}`))
  return toHex(sig)
}

// 長さが同じ16進文字列どうしを、途中で打ち切らずに比べる
function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// 共有の状態（一覧の表示と、受け取りページの判定の両方で使う）
export function shareStatus(row, now = Date.now()) {
  if (row.revoked_at) return 'revoked'
  if (row.locked_at) return 'locked'
  if (new Date(row.expires_at).getTime() <= now) return 'expired'
  if (row.open_count >= row.max_opens) return 'used_up'
  // 一覧では object_key を読まないので、消したかどうかは file_deleted_at で見る
  if (row.file_deleted_at || row.object_key === null) return 'deleted'
  return 'active'
}

const slashDate = (iso) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000)
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`
}
const slashDateTime = (iso) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000)
  return `${slashDate(iso)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

function draftBody({ recipientName, title, url, expiresAt, maxOpens }) {
  return [
    `${recipientName} 様`,
    '',
    'いつもお世話になっております。',
    `${title}をお送りします。下のリンクを開き、パスワードを入力してご覧ください。`,
    '',
    url,
    '',
    '・パスワードは、このメールとは別に携帯電話のショートメッセージ（SMS）またはお電話でお知らせします。',
    `・有効期限: ${slashDateTime(expiresAt)} まで（開ける回数: ${maxOpens}回まで）`,
    '・個人情報を含むため、受け取ったファイルの取り扱いにはご注意ください。',
    '',
  ].join('\n')
}

// POST /api/secure-shares（multipart）— 共有を作る。
// フォーム: pdf（ファイル）・title（書類名）・contact_id（連絡帳の id）・days・max_opens・draft（'1' なら Gmail の下書きも作る）。
// 送り先は連絡帳から選ぶ（2026-10-26 依頼。携帯電話番号とメールアドレスの両方があるものだけ）。名前・アドレス・携帯番号は
// 画面から受け取らず、サーバーが連絡帳から引き直す（ビルメンの案内メールの宛先と同じ考え方）
// 返す: { share, url, passcode, draft_url? }。url と passcode はこの応答でしか分からない
export async function handleSecureShareCreate(req) {
  const { auth, error } = await requireStaff(req)
  if (error) return error
  try {
    const form = await req.formData().catch(() => null)
    if (!form) return json({ error: 'フォームの受け取りに失敗しました' }, 400)
    const pdf = form.get('pdf')
    const title = text(form.get('title'), 100)
    const contactId = String(form.get('contact_id') || '')
    const days = intIn(form.get('days'), SHARE_DEFAULT_DAYS, 1, SHARE_MAX_DAYS)
    const maxOpens = intIn(form.get('max_opens'), SHARE_DEFAULT_OPENS, 1, SHARE_MAX_OPENS)
    const wantDraft = form.get('draft') === '1'

    if (!pdf || typeof pdf === 'string') return json({ error: 'PDF がありません' }, 400)
    if (pdf.size > PDF_MAX_BYTES) return json({ error: 'PDF が大きすぎます（20MBまで）' }, 400)
    if (!title) return json({ error: '書類名がありません' }, 400)
    if (!UUID_RE.test(contactId)) return json({ error: '送り先を連絡帳から選んでください' }, 400)
    const supabase = getAdminClient()
    const { data: contact, error: contactErr } = await supabase
      .from('contacts')
      .select('id, company_name, contact_person, mobile_phone, email_to')
      .eq('id', contactId)
      .maybeSingle()
    if (contactErr) throw new Error(contactErr.message)
    if (!contact) return json({ error: '連絡帳に送り先が見つかりません' }, 400)
    const recipientName = [contact.company_name, contact.contact_person].map((v) => (v || '').trim()).filter(Boolean).join(' ').slice(0, 100)
    // メールTO に複数書かれていても、最初の1件だけに送る
    const recipientEmail = (contact.email_to || '').split(/[,;、\s]+/).find(Boolean) || ''
    const recipientMobile = (contact.mobile_phone || '').trim().slice(0, 30)
    if (!recipientEmail || !recipientMobile) {
      return json({ error: '連絡帳の携帯電話番号とメールアドレスの両方が登録されている送り先を選んでください' }, 400)
    }
    if (!EMAIL_RE.test(recipientEmail)) return json({ error: '連絡帳のメールアドレスの形が正しくありません' }, 400)

    const bytes = new Uint8Array(await pdf.arrayBuffer())
    // PDF 以外を置かせない（先頭が %PDF-）
    if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') {
      return json({ error: 'PDF ではないファイルです' }, 400)
    }

    const id = crypto.randomUUID()
    const token = newToken()
    const passcode = newPasscode()
    const objectKey = `${id}.pdf`
    const filename = (text(pdf.name, 150) || `${title}.pdf`).replace(/[\\/:*?"<>|\r\n]/g, '_')
    const expiresAt = new Date(Date.now() + days * 86400 * 1000).toISOString()

    await putObject(objectKey, bytes, 'application/pdf', { bucket: SHARE_BUCKET })
    const { data: share, error: insErr } = await supabase
      .from('secure_shares')
      .insert({
        id,
        token_hash: await sha256Hex(token),
        passcode_hash: await passcodeHash(id, passcode),
        title,
        filename,
        object_key: objectKey,
        size_bytes: bytes.length,
        recipient_name: recipientName,
        recipient_email: recipientEmail,
        recipient_mobile: recipientMobile,
        contact_id: contact.id,
        expires_at: expiresAt,
        max_opens: maxOpens,
        created_by: actorOf(auth),
      })
      .select(LIST_COLUMNS)
      .single()
    if (insErr) {
      console.error('secure-share-create:', insErr.message)
      await deleteObject(objectKey, SHARE_BUCKET)
      return json({ error: '共有の作成に失敗しました' }, 500)
    }

    const url = `${new URL(req.url).origin}/s/${token}`
    const result = { share: { ...share, status: shareStatus(share) }, url, passcode }

    if (wantDraft) {
      try {
        const raw = buildMimeMessage({
          to: [{ name: recipientName, email: recipientEmail }],
          subject: `${title}の送付（パスワード付きリンク）`,
          body: draftBody({ recipientName, title, url, expiresAt, maxOpens }),
        })
        const draft = await createDraft(await getAccessToken(), raw)
        const { data: shared } = await supabase.from('settings').select('value').eq('key', 'shared_gmail').maybeSingle()
        const account = (shared?.value || '').trim()
        const base = `https://mail.google.com/mail/${account ? `?authuser=${encodeURIComponent(account)}` : 'u/0/'}`
        const messageId = draft?.message?.id || ''
        result.draft_url = messageId ? `${base}#drafts?compose=${messageId}` : `${base}#drafts`
      } catch (err) {
        // 共有自体はできているので、下書きの失敗は知らせるだけにする（リンクを手で貼れば送れる）
        console.error('secure-share-draft:', err)
        result.draft_error = 'Gmail の下書きを作れませんでした。表示されたリンクをメールに貼って送ってください'
      }
    }
    return json(result)
  } catch (err) {
    console.error('secure-share-create 失敗:', err)
    return json({ error: '共有の作成に失敗しました' }, 500)
  }
}

// GET /api/secure-shares — 共有の一覧（新しい順・200件）と、それぞれの開いた・間違えた記録
export async function handleSecureShareList(req) {
  const { error } = await requireStaff(req)
  if (error) return error
  try {
    const supabase = getAdminClient()
    const { data, error: listErr } = await supabase
      .from('secure_shares')
      .select(`${LIST_COLUMNS}, secure_share_access_log(accessed_at, result, ip)`)
      .order('created_at', { ascending: false })
      .limit(200)
    if (listErr) {
      console.error('secure-share-list:', listErr.message)
      return json({ error: '共有の一覧を取得できませんでした' }, 500)
    }
    const now = Date.now()
    const shares = (data || []).map(({ secure_share_access_log: log, ...row }) => ({
      ...row,
      status: shareStatus(row, now),
      log: (log || []).sort((a, b) => b.accessed_at.localeCompare(a.accessed_at)).slice(0, 30),
    }))
    return json({ shares, defaults: { days: SHARE_DEFAULT_DAYS, max_opens: SHARE_DEFAULT_OPENS } })
  } catch (err) {
    console.error('secure-share-list 失敗:', err)
    return json({ error: '共有の一覧を取得できませんでした' }, 500)
  }
}

// PATCH /api/secure-shares — { id, action: 'revoke' | 'reissue' }
//   revoke  … 取り消す（すぐに PDF も消す）
//   reissue … パスコードを作り直す（間違いで止まったリンクも再び使えるようにする）。新しいパスコードを返す
export async function handleSecureShareUpdate(req) {
  const { auth, error } = await requireStaff(req)
  if (error) return error
  try {
    const body = await req.json().catch(() => ({}))
    const id = String(body.id || '')
    if (!UUID_RE.test(id)) return json({ error: 'id が正しくありません' }, 400)
    const supabase = getAdminClient()
    const { data: row, error: getErr } = await supabase.from('secure_shares').select('*').eq('id', id).maybeSingle()
    if (getErr) throw new Error(getErr.message)
    if (!row) return json({ error: '共有が見つかりません' }, 404)

    if (body.action === 'revoke') {
      if (row.object_key) await deleteObject(row.object_key, SHARE_BUCKET)
      const now = new Date().toISOString()
      const { data, error: upErr } = await supabase
        .from('secure_shares')
        .update({ revoked_at: row.revoked_at || now, revoked_by: row.revoked_by || actorOf(auth), object_key: null, file_deleted_at: now })
        .eq('id', id)
        .select(LIST_COLUMNS)
        .single()
      if (upErr) throw new Error(upErr.message)
      return json({ share: { ...data, status: 'revoked' } })
    }

    if (body.action === 'reissue') {
      if (row.revoked_at || !row.object_key) return json({ error: '取り消した・ファイルを消した共有は再発行できません' }, 400)
      const passcode = newPasscode()
      const { data, error: upErr } = await supabase
        .from('secure_shares')
        .update({ passcode_hash: await passcodeHash(id, passcode), failed_attempts: 0, locked_at: null })
        .eq('id', id)
        .select(LIST_COLUMNS)
        .single()
      if (upErr) throw new Error(upErr.message)
      return json({ share: { ...data, status: shareStatus(data) }, passcode })
    }
    return json({ error: 'action が正しくありません' }, 400)
  } catch (err) {
    console.error('secure-share-update 失敗:', err)
    return json({ error: '共有の更新に失敗しました' }, 500)
  }
}

// ============================================================
// 受け取る側のページ（ログイン不要）。GET /s/<token> でパスコードの入力欄、POST で PDF を返す。
// 画面は素の HTML のフォーム（JavaScript が無くても動く）。押したときの反応（準備中・ダウンロードを始めた表示）だけを
// public/share/share.js で足す（2026-10-26 依頼。反応が無く何度も押してしまうため）。
// 書式は public/share/share.css（埋め込みの <style> は CSP で無視されるため）
// ============================================================

const escHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  // URL にリンクの文字列が入っているので、外へのリンク・検索エンジンに渡さない
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
}

function page(status, { heading, body }) {
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>${escHtml(heading)}</title><link rel="stylesheet" href="/share/share.css"><script src="/share/share.js" defer></script></head>
<body><main class="card"><h1>${escHtml(heading)}</h1>${body}</main></body></html>`
  return new Response(html, { status, headers: PAGE_HEADERS })
}

const UNAVAILABLE = {
  revoked: 'このリンクは送り主によって取り消されました。',
  locked: 'パスワードを続けて間違えたため、このリンクは止まっています。送り主にご連絡ください。',
  expired: 'このリンクは有効期限を過ぎています。',
  used_up: 'このリンクは開ける回数の上限に達しました。',
  deleted: 'このファイルはすでに削除されています。',
}

function unavailablePage(status) {
  return page(410, {
    heading: 'ファイルを開けません',
    body: `<p>${escHtml(UNAVAILABLE[status] || 'このリンクは使えません。')}</p><p class="muted">必要な場合は送り主にお問い合わせください。</p>`,
  })
}

function notFoundPage() {
  return page(404, {
    heading: 'ファイルを開けません',
    body: '<p>リンクが正しくないか、すでに使えなくなっています。</p><p class="muted">メールのリンクを途中で切らずに開いているかご確認ください。</p>',
  })
}

function formPage(row, token, message = '') {
  const left = row.max_opens - row.open_count
  return page(message ? 400 : 200, {
    heading: '書類の受け取り',
    body: `<p class="doc">${escHtml(row.title)}</p>
<dl><dt>宛先</dt><dd>${escHtml(row.recipient_name)} 様</dd>
<dt>有効期限</dt><dd>${escHtml(slashDateTime(row.expires_at))} まで</dd>
<dt>開ける回数</dt><dd>あと <span id="left">${left}</span> 回</dd></dl>
${message ? `<p class="error" role="alert">${escHtml(message)}</p>` : ''}
<form method="post" action="/s/${escHtml(token)}">
<label for="passcode">パスワード（6桁の数字）</label>
<input id="passcode" name="passcode" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9０-９ ]*" maxlength="12" required autofocus>
<button type="submit" id="open">開く（PDF をダウンロード）</button>
<p id="status" class="status" role="status" aria-live="polite" hidden></p>
</form>
<p class="muted">パスワードは、送り主からメールとは別の方法（ショートメッセージやお電話）でお知らせしています。${MAX_FAILED}回続けて間違えるとこのリンクは使えなくなります。</p>`,
  })
}

async function logAccess(supabase, shareId, result, req) {
  try {
    await supabase.from('secure_share_access_log').insert({
      share_id: shareId,
      result,
      ip: (req.headers.get('cf-connecting-ip') || '').slice(0, 64) || null,
      user_agent: (req.headers.get('user-agent') || '').slice(0, 300) || null,
    })
  } catch (err) {
    console.error('secure-share-log 失敗:', err)
  }
}

async function findByToken(supabase, token) {
  if (!TOKEN_RE.test(token)) return null
  const { data, error } = await supabase.from('secure_shares').select('*').eq('token_hash', await sha256Hex(token)).maybeSingle()
  if (error) throw new Error(error.message)
  return data
}

// GET・POST /s/<token>
export async function handleSharePage(req, token) {
  try {
    const supabase = getAdminClient()
    const row = await findByToken(supabase, token)
    if (!row) return notFoundPage()
    const status = shareStatus(row)
    if (status !== 'active') {
      if (req.method === 'POST') await logAccess(supabase, row.id, status, req)
      return unavailablePage(status)
    }
    if (req.method !== 'POST') return formPage(row, token)

    const form = await req.formData().catch(() => null)
    const passcode = String(form?.get('passcode') || '')
      .normalize('NFKC')
      .replace(/\D/g, '')
    if (!passcode || !sameHex(await passcodeHash(row.id, passcode), row.passcode_hash)) {
      const failed = row.failed_attempts + 1
      const lock = failed >= MAX_FAILED
      await supabase
        .from('secure_shares')
        .update({ failed_attempts: failed, locked_at: lock ? new Date().toISOString() : null })
        .eq('id', row.id)
      await logAccess(supabase, row.id, 'wrong_passcode', req)
      if (lock) return unavailablePage('locked')
      return formPage(row, token, `パスワードが違います（あと ${MAX_FAILED - failed} 回で使えなくなります）`)
    }

    // 開いた回数を数える。同時に開かれても上限を超えないよう、読んだときの回数のままなら足す
    const { data: counted, error: upErr } = await supabase
      .from('secure_shares')
      .update({ open_count: row.open_count + 1, failed_attempts: 0, last_opened_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('open_count', row.open_count)
      .select('id')
    if (upErr) throw new Error(upErr.message)
    if (!counted?.length) return formPage(row, token, 'もう一度お試しください')

    const file = await getObject(row.object_key, SHARE_BUCKET)
    if (!file.ok) {
      console.error(`secure-share-open: Storage から取得できません (${file.status})`)
      return page(500, { heading: 'ファイルを開けません', body: '<p>ファイルを読み出せませんでした。時間をおいてもう一度お試しください。</p>' })
    }
    await logAccess(supabase, row.id, 'opened', req)
    const star = `UTF-8''${encodeURIComponent(row.filename)}`
    // ダウンロードが始まったことをページの share.js に知らせる目印（送られてきた値をそのまま Cookie で返す）
    const dl = String(form?.get('dl') || '')
    const signal = /^[a-z0-9]{8,32}$/.test(dl) ? { 'Set-Cookie': `share_dl=${dl}; Path=/s; Max-Age=120; Secure; SameSite=Strict` } : {}
    return new Response(file.body, {
      headers: {
        ...signal,
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="share.pdf"; filename*=${star}`,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    })
  } catch (err) {
    console.error('secure-share-page 失敗:', err)
    return page(500, { heading: 'エラー', body: '<p>処理中にエラーが起きました。時間をおいてもう一度お試しください。</p>' })
  }
}

// 毎日の定期処理: 期限切れ・取り消し・パスコード間違いで止まった・回数を使い切った共有の PDF を消す（記録の行は残す）
export async function cleanupSecureShares() {
  const supabase = getAdminClient()
  const { data, error } = await supabase
    .from('secure_shares')
    .select('id, object_key, expires_at, max_opens, open_count, locked_at, revoked_at, file_deleted_at')
    .not('object_key', 'is', null)
    .limit(500)
  if (error) throw new Error(error.message)
  const now = Date.now()
  // 止まった（locked）ものは再発行できるよう、期限までは残す
  const targets = (data || []).filter((r) => {
    const s = shareStatus(r, now)
    return s === 'expired' || s === 'used_up' || s === 'revoked'
  })
  if (!targets.length) return 0
  await deleteObjects(
    targets.map((r) => r.object_key),
    SHARE_BUCKET,
  )
  const { error: upErr } = await supabase
    .from('secure_shares')
    .update({ object_key: null, file_deleted_at: new Date(now).toISOString() })
    .in(
      'id',
      targets.map((r) => r.id),
    )
  if (upErr) throw new Error(upErr.message)
  return targets.length
}
