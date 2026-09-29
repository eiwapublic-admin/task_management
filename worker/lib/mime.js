// 添付付きメール（RFC 5322 / MIME）を組み立てる小さな部品（2026-09-29〜）。
// ビルメンの案内メール 方式A（Gmail下書きの自動作成・PDF自動添付。docs/bilmen-plan.md 7-3）で使う。
// Gmail API の下書き作成（worker/lib/gmail.js の createDraft）へ、ここで作った生のメッセージを渡す。
//
// 外部ライブラリは使わない（Workers のバンドルを増やさないため。gmail.js と同じ方針）。
// 日本語を含むヘッダーは RFC 2047 の encoded-word（=?UTF-8?B?...?=）にし、
// 本文と添付は base64 で送る。どちらも「どのメールソフトで開いても文字化けしない」ことを優先した選択。
//
// 入力はすべて呼び出し側で検証済みの前提（宛先のアドレス形式の検証などはここではしない）。

const CRLF = '\r\n'

function isAscii(text) {
  return /^[\x20-\x7e]*$/.test(text)
}

function utf8Base64(text) {
  return Buffer.from(text, 'utf-8').toString('base64')
}

// 日本語を含むヘッダー値を encoded-word にする。1語は75字以内という RFC 2047 の上限を守るため、
// UTF-8 で約45バイトごと（base64で60字）に**文字の途中で切らずに**区切り、折り返しでつなぐ
export function encodeHeaderText(text) {
  const value = String(text ?? '')
  if (isAscii(value)) return value
  const words = []
  let chunk = ''
  let chunkBytes = 0
  for (const ch of value) {
    const bytes = Buffer.byteLength(ch, 'utf-8')
    if (chunkBytes + bytes > 45 && chunk) {
      words.push(chunk)
      chunk = ''
      chunkBytes = 0
    }
    chunk += ch
    chunkBytes += bytes
  }
  if (chunk) words.push(chunk)
  return words.map((w) => `=?UTF-8?B?${utf8Base64(w)}?=`).join(`${CRLF} `)
}

// 「宛先名 <アドレス>」の形。宛先名が日本語なら encoded-word にし、
// ASCII だけの名前は引用符で囲む（名前に「,」があっても宛先が割れないように。
// 方式Bの formatMailAddress（src/lib/bilmen.js）と同じ考え方）
export function formatAddress(name, email) {
  const addr = String(email || '').trim()
  const label = String(name || '').trim()
  if (!addr) return ''
  if (!label) return addr
  const encoded = isAscii(label) ? `"${label.replace(/([\\"])/g, '\\$1')}"` : encodeHeaderText(label)
  return `${encoded} <${addr}>`
}

// base64 を76字ごとに改行する（MIME の行長の上限）
function wrapBase64(b64) {
  return b64.replace(/.{1,76}/g, (line) => line + CRLF).trimEnd()
}

// 添付ファイル名。RFC 2231（filename*=UTF-8''...）と、古いメールソフト向けの
// RFC 2047 の name= を両方付ける（Gmail・Outlook・iPhoneのメールのどれでも日本語名が出るように）
//
// Content-ID と X-Attachment-Id（2026-09-29〜）: この下書きを Gmail の画面で開いて送ると、
// Gmail はメールを組み立て直し、添付のパートに**元のパートの値を引き継いだ** Content-ID と
// X-Attachment-Id を付ける。元に無いと `Content-ID: <>`（空）になり、受け取った側の
// メールソフトによっては添付が「？」の壊れた画像として表示された（実際に送られたメールの
// ソースで確認。docs/bilmen-plan.md 7-3-3）。Gmail 自身が添付に付けるのと同じ形
// （f_ で始まるID）で最初から入れておく
function attachmentHeaders(filename, contentType) {
  const star = `UTF-8''${encodeURIComponent(filename)}`
  const legacy = isAscii(filename) ? filename : `=?UTF-8?B?${utf8Base64(filename)}?=`
  const attachmentId = `f_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  return [
    `Content-Type: ${contentType}; name="${legacy}"`,
    `Content-Disposition: attachment; filename="${legacy}"; filename*=${star}`,
    'Content-Transfer-Encoding: base64',
    `X-Attachment-Id: ${attachmentId}`,
    `Content-ID: <${attachmentId}>`,
  ]
}

// bcc: [{ name, email }]  subject/body: 文字列（本文は改行コードを問わない）
// attachment: { filename, contentType, bytes: Uint8Array | ArrayBuffer }
// to（任意）: [{ name, email }]。方式Bに合わせ、既定は BCC のみ（テナント同士にアドレスを見せない）
// replyTo（任意）: [{ name, email }]。受け取った側が「返信」したときの宛先（2026-09-29〜。
// 送信元＝共有アドレスではなく、管理事務所の窓口へ返信が届くようにするため）
export function buildMimeMessage({ to = [], bcc = [], replyTo = [], subject, body, attachment }) {
  const boundary = `=_bilmen_${crypto.randomUUID().replace(/-/g, '')}`
  const addressList = (list) => list.map((r) => formatAddress(r.name, r.email)).filter(Boolean).join(`,${CRLF} `)

  const headers = ['MIME-Version: 1.0']
  if (to.length > 0) headers.push(`To: ${addressList(to)}`)
  if (bcc.length > 0) headers.push(`Bcc: ${addressList(bcc)}`)
  if (replyTo.length > 0) headers.push(`Reply-To: ${addressList(replyTo)}`)
  headers.push(`Subject: ${encodeHeaderText(subject)}`)
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)

  const normalizedBody = String(body ?? '').replace(/\r?\n/g, CRLF)
  const parts = [
    [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(utf8Base64(normalizedBody)),
    ].join(CRLF),
  ]

  if (attachment) {
    const bytes = attachment.bytes instanceof Uint8Array ? attachment.bytes : new Uint8Array(attachment.bytes)
    parts.push(
      [
        `--${boundary}`,
        ...attachmentHeaders(attachment.filename, attachment.contentType || 'application/octet-stream'),
        '',
        wrapBase64(Buffer.from(bytes).toString('base64')),
      ].join(CRLF),
    )
  }

  return [...headers, '', ...parts, `--${boundary}--`, ''].join(CRLF)
}
