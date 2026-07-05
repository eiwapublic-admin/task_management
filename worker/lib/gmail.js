// Gmail API を fetch で直接叩く軽量クライアント（追加依存なし）。
// OAuth2 のリフレッシュトークン方式でアクセストークンを取得し、
// 共有アドレス（eiwa.public@gmail.com）の受信メールを読み取る。
// スコープは gmail.readonly を想定（読み取り専用）。

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

export async function getAccessToken() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error('Gmail の環境変数（CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN）が不足しています')
  }
  const body = new URLSearchParams({
    client_id: GMAIL_CLIENT_ID,
    client_secret: GMAIL_CLIENT_SECRET,
    refresh_token: GMAIL_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  })
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Gmail トークン取得に失敗しました (${res.status}): ${text}`)
  }
  const data = await res.json()
  return data.access_token
}

async function apiGet(accessToken, path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Gmail API エラー (${res.status}) ${path}: ${text}`)
  }
  return res.json()
}

// クエリに一致するメッセージ ID の一覧を取得する。
export async function listMessageIds(accessToken, query, maxResults = 50) {
  const params = new URLSearchParams({ q: query, maxResults: String(maxResults) })
  const data = await apiGet(accessToken, `/messages?${params}`)
  return data.messages || []
}

// Base64URL → UTF-8 文字列
function decodeBody(data) {
  if (!data) return ''
  try {
    const normalized = data.replace(/-/g, '+').replace(/_/g, '/')
    return Buffer.from(normalized, 'base64').toString('utf-8')
  } catch {
    return ''
  }
}

// payload を再帰的に辿って本文テキストを抽出する。
// text/plain を優先し、無ければ text/html を簡易的にタグ除去して使う。
function extractText(payload) {
  if (!payload) return ''
  const plain = findPart(payload, 'text/plain')
  if (plain) return decodeBody(plain)
  const html = findPart(payload, 'text/html')
  if (html) {
    return decodeBody(html)
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return ''
}

function findPart(payload, mimeType) {
  if (payload.mimeType === mimeType && payload.body?.data) {
    return payload.body.data
  }
  for (const part of payload.parts || []) {
    const found = findPart(part, mimeType)
    if (found) return found
  }
  return null
}

function header(payload, name) {
  const h = (payload.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase())
  return h ? h.value : ''
}

// 1 通のメッセージを取得し、扱いやすい形に整形して返す。
export async function getMessage(accessToken, id) {
  const msg = await apiGet(accessToken, `/messages/${id}?format=full`)
  const payload = msg.payload || {}
  const bodyText = extractText(payload)
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: header(payload, 'From'),
    replyTo: header(payload, 'Reply-To'),
    to: header(payload, 'To'),
    subject: header(payload, 'Subject'),
    date: header(payload, 'Date'),
    snippet: msg.snippet || '',
    receivedAt: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null,
    body: bodyText || msg.snippet || '',
  }
}

// スレッドの最新メッセージの From を返す（返信検知用）。
export async function getThreadLatestFrom(accessToken, threadId) {
  const thread = await apiGet(accessToken, `/threads/${threadId}?format=metadata&metadataHeaders=From`)
  const messages = thread.messages || []
  if (messages.length === 0) return null
  const last = messages[messages.length - 1]
  return header(last.payload || {}, 'From')
}
