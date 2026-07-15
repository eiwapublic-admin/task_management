// タスク詳細の「メール参照」「返信」用ヘルパー

// 当社メーリングリスト。返信時は必ず CC に入れる。
// if@eiwa-up.jp 宛のメールは共有アドレス（eiwa.public@gmail.com）にも配信されるため、
// 返信もこのシステムの返信検知の対象になる。
export const REPLY_CC = 'if@eiwa-up.jp'

const DEFAULT_SHARED_GMAIL = 'eiwa.public@gmail.com'
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/

// "名前 <a@b.jp>" のような文字列から最初のメールアドレスを取り出す
export function extractEmail(str) {
  const m = typeof str === 'string' ? str.match(EMAIL_RE) : null
  return m ? m[0] : null
}

// Gmail のウェブ画面で該当メールを開く URL。
// パスに /u/<アドレス> を埋め込む形式は 404（Temporary Error）になることがあるため、
// authuser クエリで共有アカウントを指定する。
export function gmailMessageUrl(task, sharedGmail) {
  if (!task?.gmail_message_id) return null
  const account = sharedGmail || DEFAULT_SHARED_GMAIL
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}#all/${task.gmail_message_id}`
}

// mailto: リンクを組み立てる。
// TO はタスクの返信先（フォーム経由は本文記載のアドレスをサーバー側で抽出済み）、
// CC には必ず当社メーリングリストを入れる。本文には元メールを引用する。
export function buildReplyMailto(task) {
  const to = task?.sender_email || extractEmail(task?.sender)
  if (!to) return null

  const subject = /^re:/i.test(task.subject || '') ? task.subject : `Re: ${task.subject || ''}`

  const quoted = (task.body_preview || '')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\r\n')

  // 本文の先頭に先方の宛名（会社・氏名＋様）を入れ、そのあと2行の空行を空ける。
  // contact（AI 抽出の敬称付き宛名）を優先し、無ければ sender_display に「様」を付ける。
  const greeting = task.contact || (task.sender_display ? `${task.sender_display} 様` : '')
  // greeting のあとに空行を2つ（= 配列の '' 2個）入れてから元メッセージを続ける
  const greetingLines = greeting ? [greeting, '', ''] : ['', '']

  const body = [
    ...greetingLines,
    `----- 元のメッセージ -----`,
    `差出人: ${task.sender_display || task.sender || ''}`,
    `件名: ${task.subject || ''}`,
    '',
    quoted,
  ].join('\r\n')

  const params = new URLSearchParams({ cc: REPLY_CC, subject, body })
  // URLSearchParams はスペースを + にするため、mailto では %20 に戻す
  return `mailto:${encodeURIComponent(to)}?${params.toString().replace(/\+/g, '%20')}`
}
