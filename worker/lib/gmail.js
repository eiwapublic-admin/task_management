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
      // 改行を伴うブロック要素は改行に変換してから他のタグを除去する（改行を保持するため）
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      // 横方向の空白のみ圧縮し、改行は保持する
      .replace(/[ \t ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
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

// payload を再帰的に辿って添付ファイルのメタ情報を集める。
// 実ファイル添付（filename と body.attachmentId を持つ）のみ対象とし、
// 署名などに埋め込まれたインライン画像（Content-Disposition: inline の image/*）は除外する。
function collectAttachments(payload, out) {
  if (!payload) return
  const filename = payload.filename || ''
  const attachmentId = payload.body?.attachmentId
  if (filename && attachmentId) {
    const disposition = header(payload, 'Content-Disposition').toLowerCase()
    const isInline = disposition.startsWith('inline')
    const isImage = (payload.mimeType || '').startsWith('image/')
    if (!(isInline && isImage)) {
      out.push({
        filename,
        mimeType: payload.mimeType || 'application/octet-stream',
        size: payload.body?.size || 0,
        attachmentId,
      })
    }
  }
  for (const part of payload.parts || []) collectAttachments(part, out)
}

export function extractAttachments(payload) {
  const out = []
  collectAttachments(payload || {}, out)
  return out
}

// 1 通のメッセージの添付ファイル一覧（メタ情報のみ）を返す。
export async function getMessageAttachments(accessToken, id) {
  const msg = await apiGet(accessToken, `/messages/${encodeURIComponent(id)}?format=full`)
  return extractAttachments(msg.payload || {})
}

// スレッド内の全メッセージの添付（メタ情報）を、各添付に所属メッセージ ID を付けて返す。
// 返信で本文が上書きされても、最初・途中の返信に添付されたファイルが失われないよう、
// スレッド全体の添付を集約して表示するために使う。
// counterpart（対象顧客のアドレス）を渡すと、その顧客が参加している（From/To/Cc に含む）
// メッセージの添付だけを対象にする。同一件名で複数顧客が1スレッドにまとまった場合に、
// 別顧客宛メッセージの添付が混ざるのを防ぐ。
export async function getThreadAttachments(accessToken, threadId, counterpart = '') {
  const thread = await apiGet(accessToken, `/threads/${encodeURIComponent(threadId)}?format=full`)
  const messages = thread.messages || []
  const cp = (counterpart || '').toLowerCase()
  const out = []
  for (const m of messages) {
    const payload = m.payload || {}
    if (cp) {
      const participants = `${header(payload, 'From')} ${header(payload, 'To')} ${header(payload, 'Cc')}`.toLowerCase()
      if (!participants.includes(cp)) continue
    }
    for (const a of extractAttachments(payload)) {
      out.push({ ...a, messageId: m.id })
    }
  }
  return out
}

// 添付ファイルの実体（base64url 文字列）とサイズを返す。
export async function getAttachmentData(accessToken, messageId, attachmentId) {
  const data = await apiGet(
    accessToken,
    `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
  )
  return { data: data.data || '', size: data.size || 0 }
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
    cc: header(payload, 'Cc'),
    subject: header(payload, 'Subject'),
    date: header(payload, 'Date'),
    snippet: msg.snippet || '',
    receivedAt: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null,
    body: bodyText || msg.snippet || '',
  }
}

// スレッドの全メッセージのメタ情報（id / From / To / Cc）を古い順に返す（返信検知用）。
// スレッドの「最新の自社発メッセージ」を選ぶために、末尾だけでなく全件のメタを取得する
// （顧客が受領返信を最後に送っていても、担当者の最新の更新返信を拾えるようにするため）。
export async function getThreadMessages(accessToken, threadId) {
  const thread = await apiGet(
    accessToken,
    `/threads/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc`
  )
  const messages = thread.messages || []
  return messages.map((m) => ({
    id: m.id,
    from: header(m.payload || {}, 'From'),
    to: header(m.payload || {}, 'To'),
    cc: header(m.payload || {}, 'Cc'),
  }))
}
