// Claude API（Anthropic Messages API）でメールを分類する。
// 追加依存を避けるため fetch で直接叩く。
// コスト最適化のため既定モデルは claude-haiku-4-5（環境変数 CLAUDE_MODEL で上書き可）。

const API_ENDPOINT = 'https://api.anthropic.com/v1/messages'
const DEFAULT_MODEL = 'claude-haiku-4-5'

// 応答テキストから最初の JSON オブジェクトを頑健に取り出す。
function extractJson(text) {
  if (!text) return null
  // ```json ... ``` で囲まれている場合を先に剥がす
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}

function buildSystemPrompt({ assignees, orgContext, businessKeywords, today }) {
  const names = assignees.join('、')
  return [
    'あなたは有限会社 栄和の業務メール分類アシスタントです。',
    '受信したメール1通を分析し、指定のJSON形式のみで回答してください。説明文やコードフェンスは不要です。',
    '',
    '【当社の担当者】以下の3名のいずれかを主担当に割り当てます。',
    names,
    '',
    '【業務背景・振り分けルール】',
    orgContext || '（特に指定なし）',
    businessKeywords ? `\n【業務判定の追加キーワードヒント】\n${businessKeywords}` : '',
    '',
    `【本日の日付】${today}（JST）。「来週末」「今月中」などの相対表現はこの日付を基準にYYYY-MM-DD形式へ変換してください。`,
    '',
    '【添付ファイル（PDF・画像）の読み取り】',
    'このメッセージには PDF や画像の添付ファイルが同梱されることがあります（複合機からのFAX転送メールや、注文書・見積書・請求書などのPDF）。',
    '添付がある場合は、その中身も必ず読み取り、本文と合わせて業務タスクかどうかを判断してください。',
    'FAX 転送メールは本文がほとんど無く（件名が「Attached Image」等）、内容はすべて添付の画像/PDFにあります。この場合は添付の内容だけで判断してください。',
    '添付から読み取った内容は document_summary に日本語で分かりやすくまとめてください。特に「顧客（差出人の会社・氏名）」「資料の種類・件名（注文書/見積書/請求書/納品書など）」「金額・数量・納期・品番などの要点」を優先して記載します。表組みは文章で要約して構いません。複数ファイルがあればファイルごとに区切って要約してください。',
    '添付の内容から会社名・氏名・宛名・期限が読み取れる場合は、title・sender_display・contact・due_date にも反映してください。',
    '',
    '【出力JSONの形式】',
    '{',
    '  "is_business_task": true か false（広告・ニュースレター・自動通知・営業/プロモーションは false）,',
    `  "assignee": ${assignees.map((a) => `"${a}"`).join(' / ')} のいずれか。業務メールでないとき、または担当者を特定できないときは null,`,
    '  "due_date": "YYYY-MM-DD" 期限が読み取れないときは null,',
    '  "title": "タスクの内容がひと目で分かる簡潔な日本語タイトル（30字以内）",',
    '  "sender_display": "株式会社サンプル 山田太郎" のように送信元の会社名と氏名。問い合わせフォーム経由のメールは本文に記載された会社名・氏名を優先して読み取る。一方しか分からなければ分かる方だけ。どちらも不明なら null,',
    '  "contact": "先方（顧客）の担当者への宛名。会社名・氏名に敬称『様』を付けた形（例:『實守紙業株式会社 小林侑希 様』『中村秀利 様』）。会社名のみ/氏名のみでも可。返信メールの冒頭の宛名に使う。判断できないときは null,',
    '  "sender_email": "返信すべきメールアドレス。問い合わせフォーム経由のメールは本文に記載された差出人のメールアドレスを、それ以外は From のアドレスを返す。不明なら null",',
    '  "document_summary": "添付のPDF・画像（FAXを含む）から読み取った内容の要約。顧客・資料の件名・金額/数量/納期などの要点を日本語でまとめる。表は文章で要約。添付が無い、または読み取れないときは null",',
    '  "reason": "業務/非業務の判断根拠と、担当者を選んだ理由を1〜2文で簡潔に"',
    '}',
    '',
    '担当者を明確に特定できない場合は、無理に割り当てず assignee を null にしてください（後で担当者が手動で設定します）。',
    '必ず有効なJSONのみを返してください。',
  ].join('\n')
}

// documents: 添付の PDF/画像を Claude に渡すためのブロック配列。
//   { type: 'pdf', data }（data はパディング済み標準 base64）
//   { type: 'image', mediaType, data }
// 省略時（[]）は従来どおりテキストのみで分類する。
export async function classifyEmail(email, context, documents = []) {
  const { ANTHROPIC_API_KEY } = process.env
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY が設定されていません')
  }
  const model = process.env.CLAUDE_MODEL || DEFAULT_MODEL

  const system = buildSystemPrompt(context)
  const attachmentNote =
    email.attachments && email.attachments.length
      ? email.attachments.map((a) => `${a.filename || '(名称なし)'}（${a.mimeType}）`).join('、')
      : 'なし'
  const userText = [
    `差出人(From): ${email.from}`,
    `宛先(To): ${email.to}`,
    `件名(Subject): ${email.subject}`,
    `受信日時: ${email.date}`,
    `添付ファイル: ${attachmentNote}`,
    '本文:',
    (email.body || '').slice(0, 4000),
  ].join('\n')

  // ドキュメントブロック（PDF/画像）はテキストブロックより前に置く。
  const content = []
  for (const doc of documents || []) {
    if (doc && doc.type === 'pdf' && doc.data) {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: doc.data },
      })
    } else if (doc && doc.type === 'image' && doc.data && doc.mediaType) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: doc.mediaType, data: doc.data },
      })
    }
  }
  content.push({ type: 'text', text: userText })
  // 添付を読ませる場合は要約分の出力トークンを多めに確保する。
  const hasDocs = content.length > 1

  const res = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: hasDocs ? 1500 : 400,
      system,
      messages: [{ role: 'user', content }],
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    const err = new Error(`Claude API エラー (${res.status}): ${text}`)
    // クレジット残高不足の検知（残高ゼロ時は 400 で "credit balance is too low" 等が返る）
    if (res.status === 402 || (res.status === 400 && /credit balance|billing|insufficient|too low/i.test(text))) {
      err.isBillingError = true
    }
    throw err
  }

  const data = await res.json()
  const text = (data.content || []).map((b) => b.text || '').join('')
  const parsed = extractJson(text)
  if (!parsed) {
    throw new Error(`Claude の応答をJSONとして解釈できませんでした: ${text.slice(0, 200)}`)
  }
  const usage = {
    input_tokens: data.usage?.input_tokens || 0,
    output_tokens: data.usage?.output_tokens || 0,
  }
  return { classification: parsed, usage }
}
