// メールアドレス周りの小さなユーティリティ。
// 返信検知（pipeline）と添付集約（index）で共通に使う。

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const EMAIL_RE_G = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

// 文字列から最初のメールアドレスを取り出す（"名前 <a@b.jp>" 形式にも対応）
export function extractEmail(str) {
  const m = typeof str === 'string' ? str.match(EMAIL_RE) : null
  return m ? m[0] : null
}

// 文字列に含まれるメールアドレスをすべて小文字で取り出す（To/Cc の複数宛先用）
export function extractEmails(str) {
  const m = typeof str === 'string' ? str.match(EMAIL_RE_G) : null
  return m ? m.map((s) => s.toLowerCase()) : []
}

export function emailDomain(addr) {
  const at = typeof addr === 'string' ? addr.lastIndexOf('@') : -1
  return at > 0 ? addr.slice(at + 1).toLowerCase() : null
}

// 設定値（共有アドレス・自社ドメイン一覧）から isCompanyAddress 判定関数を作る。
export function makeIsCompanyAddress(sharedGmail, companyDomains) {
  const shared = (sharedGmail || '').toLowerCase()
  const domains = companyDomains
  return (addr) => {
    const a = (addr || '').toLowerCase()
    return Boolean(a) && (a === shared || domains.includes(emailDomain(a)))
  }
}

// カンマ区切りの company_domains 文字列を配列に整形する。
export function parseCompanyDomains(raw) {
  return (raw || 'eiwa-up.jp')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

// タスクの顧客(counterpart)アドレスを特定する。
//  - 受信メール由来（sender が顧客）: 元の送信者が顧客
//  - 自社発信由来（sender が自社）: 元メッセージ(gmail_message_id)の宛先(To/Cc)のうち自社以外が顧客
// messages は { id, to, cc } を持つスレッドメッセージ配列。
export function resolveCounterpart(task, messages, isCompanyAddress) {
  const originalFrom = (extractEmail(task.sender) || '').toLowerCase()
  if (isCompanyAddress(originalFrom)) {
    const orig = (messages || []).find((m) => m.id === task.gmail_message_id)
    const recips = orig ? extractEmails(`${orig.to || ''} ${orig.cc || ''}`) : []
    return recips.find((a) => !isCompanyAddress(a)) || ''
  }
  const se = (task.sender_email || '').toLowerCase()
  return se && !isCompanyAddress(se) ? se : originalFrom
}
