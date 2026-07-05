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
    '【出力JSONの形式】',
    '{',
    '  "is_business_task": true か false（広告・ニュースレター・自動通知・営業/プロモーションは false）,',
    `  "assignee": ${assignees.map((a) => `"${a}"`).join(' / ')} のいずれか。業務メールでないときは null,`,
    '  "due_date": "YYYY-MM-DD" 期限が読み取れないときは null,',
    '  "title": "タスクの内容がひと目で分かる簡潔な日本語タイトル（30字以内）",',
    '  "sender_display": "株式会社サンプル 山田太郎" のように送信元の会社名と氏名。問い合わせフォーム経由のメールは本文に記載された会社名・氏名を優先して読み取る。一方しか分からなければ分かる方だけ。どちらも不明なら null,',
    '  "sender_email": "返信すべきメールアドレス。問い合わせフォーム経由のメールは本文に記載された差出人のメールアドレスを、それ以外は From のアドレスを返す。不明なら null",',
    '  "reason": "業務/非業務の判断根拠と、担当者を選んだ理由を1〜2文で簡潔に"',
    '}',
    '',
    '判断できない一般的な業務メールは、既定担当として先頭の担当者に割り当ててください。',
    '必ず有効なJSONのみを返してください。',
  ].join('\n')
}

export async function classifyEmail(email, context) {
  const { ANTHROPIC_API_KEY } = process.env
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY が設定されていません')
  }
  const model = process.env.CLAUDE_MODEL || DEFAULT_MODEL

  const system = buildSystemPrompt(context)
  const userContent = [
    `差出人(From): ${email.from}`,
    `宛先(To): ${email.to}`,
    `件名(Subject): ${email.subject}`,
    `受信日時: ${email.date}`,
    '本文:',
    (email.body || '').slice(0, 4000),
  ].join('\n')

  const res = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      system,
      messages: [{ role: 'user', content: userContent }],
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
