// Claude API（Anthropic Messages API）でメールを分類する。
// 追加依存を避けるため fetch で直接叩く。
// コスト最適化のため既定モデルは claude-haiku-4-5（環境変数 CLAUDE_MODEL で上書き可）。

const API_ENDPOINT = 'https://api.anthropic.com/v1/messages'
const DEFAULT_MODEL = 'claude-haiku-4-5'

// 一時的なエラー（過負荷・レート制限・単発の拒否等）とみなして再試行するステータス。
// 401/404等の設定不備や、402/クレジット不足は再試行しても無意味なため対象外
// （クレジット不足は下の isBillingError 判定で別途扱う）。
// 2026-07-27、単発の 403「Request not allowed」でFAX1件の分類が失敗し、その後
// last_fetch_at が前進したことで永久に再取得の機会を失う事象が発生した。同じ実行内の
// 他のメッセージは正常処理できていたため、アカウント/権限レベルの恒久的な問題ではなく
// 単発の一時的な現象と判断し、再試行の対象に加えた。
const RETRYABLE_STATUS = new Set([403, 408, 409, 429, 500, 502, 503, 504, 529])
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = [800, 2000]
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 応答テキストから最初の JSON オブジェクトを頑健に取り出す。
export function extractJson(text) {
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
    '【担当者(assignee)の決め方（優先順位）】',
    `1. 宛先(To)・本文の宛名・添付文書（FAXの宛先欄等）のいずれかに、上記3名（${names}）のうち誰か1名の氏名が名指しで書かれている場合は、それを最優先で assignee にしてください。`,
    '   このとき、上記【業務背景・振り分けルール】の個別ルール（製品カテゴリ等）に一致するかどうかは問いません。宛先の人物が明記されている以上、内容がどの個別ルールにも当てはまらない・判断がつかない場合でも、宛先の人物を assignee にしてください（個別ルールは「宛先に誰も明記されていないとき」の補助的な判断材料です）。',
    '2. 宛先に担当者名が無い場合は、【業務背景・振り分けルール】の個別ルールに従って判断してください。',
    '3. どちらにも該当しない一般的な業務メールは、そのルール内の既定担当（記載が無ければ社長）に割り当ててください。',
    '4. is_business_task が false のときのみ assignee は null にしてください。業務メールと判定していながら「担当者を絞り込む決め手が無い」という理由だけで null にすることは避けてください（上記1〜3のいずれかで必ず割り当てられるはずです）。',
    '',
    `【本日の日付】${today}（JST）。「来週末」「今月中」などの相対表現はこの日付を基準にYYYY-MM-DD形式へ変換してください。`,
    '',
    '【添付ファイル（PDF・画像）の読み取り】',
    'このメッセージには PDF や画像の添付ファイルが同梱されることがあります（複合機からのFAX転送メールや、注文書・見積書・請求書などのPDF）。',
    '添付がある場合は、その中身も必ず読み取り、本文と合わせて業務タスクかどうかを判断してください。',
    'FAX 転送メールは本文がほとんど無く（件名が「Attached Image」等）、内容はすべて添付の画像/PDFにあります。この場合は添付の内容だけで判断してください。',
    '添付から読み取った内容は document_summary に日本語で分かりやすくまとめてください。特に「顧客（差出人の会社・氏名）」「資料の種類・件名（注文書/見積書/請求書/納品書など）」「金額・数量・納期・品番などの要点」を優先して記載します。表組みは文章で要約して構いません。複数ファイルがあればファイルごとに区切って要約してください。',
    '添付の内容から会社名・氏名・宛名・期限が読み取れる場合は、title・sender_display・contact・due_date にも反映してください。',
    'title は is_business_task が false（広告・プロモーション等）と判定した場合でも、内容が読み取れている限り必ず具体的に埋めてください（例:「モノタロウからの15%OFFキャンペーン」）。メールの元の件名（「Attached Image」等のFAX共通の定型件名を含む）をそのまま使い回すのは避け、実際の内容が一目で分かるタイトルにしてください。',
    '',
    '【重要: 読み取れないときに内容を創作しないこと】',
    'FAXは複合機のスキャン品質により、文字がかすれる・不鮮明・低解像度・手書きで判読困難なことがあります。',
    'このような場合、会社名・氏名・金額・内容などを推測や創作で埋めることは絶対にしないでください（誤った情報が業務に使われ、実害につながります）。',
    '添付の文字を自信を持って明確に判読できたとき、かつそのときに限り document_readable を true にしてください。少しでも不鮮明・推測が混じる場合は false にし、document_read_issue にその理由を記載してください。false のときは document_summary・title・sender_display・contact・due_date は無理に埋めず null にしてください。',
    '',
    '【出力JSONの形式】',
    '{',
    '  "is_business_task": true か false（広告・ニュースレター・自動通知・営業/プロモーションは false）,',
    `  "assignee": ${assignees.map((a) => `"${a}"`).join(' / ')} のいずれか（上記【担当者(assignee)の決め方】参照）。業務メールでないときのみ null,`,
    '  "due_date": "YYYY-MM-DD" 期限が読み取れないときは null,',
    '  "title": "タスクの内容がひと目で分かる簡潔な日本語タイトル（30字以内）。is_business_task が false でも、内容が読み取れているなら必ず具体的に埋める（メールの元の件名をそのまま使い回さない）",',
    '  "sender_display": "株式会社サンプル 山田太郎" のように送信元の会社名と氏名。問い合わせフォーム経由のメールは本文に記載された会社名・氏名を優先して読み取る。一方しか分からなければ分かる方だけ。どちらも不明なら null,',
    '  "contact": "先方（顧客）の担当者への宛名。会社名・氏名に敬称『様』を付けた形（例:『實守紙業株式会社 小林侑希 様』『中村秀利 様』）。会社名のみ/氏名のみでも可。返信メールの冒頭の宛名に使う。判断できないときは null,',
    '  "sender_email": "返信すべきメールアドレス。問い合わせフォーム経由のメールは本文に記載された差出人のメールアドレスを、それ以外は From のアドレスを返す。不明なら null",',
    '  "document_summary": "添付のPDF・画像（FAXを含む）から読み取った内容の要約。顧客・資料の件名・金額/数量/納期などの要点を日本語でまとめる。表は文章で要約。添付が無い、または読み取れないときは null",',
    '  "document_readable": "添付のPDF・画像を自信を持って明確に判読できたときのみ true。文字が不鮮明・低解像度・手書きで判読困難などで内容の一部でも推測が混じる場合は false。添付が無いときは true",',
    '  "document_read_issue": "document_readable が false のときの理由を日本語で簡潔に（例: 画像が不鮮明で文字が判読できない／解像度が低い／手書きで判読困難／添付が破損している）。true のときは null",',
    '  "channel": "このメールの経路。"email"（通常の受信メール）/ "form"（ホームページの問い合わせフォームからの自動送信メール。本文が「ホームページよりお問い合わせがありました」等の定型文で始まる）/ "fax"（複合機からのFAX転送メール。本文がほとんど無く、添付のFAX画像/PDFから内容を読み取ったもの）のいずれか。判断できないときは "email",',
    '  "reason": "業務/非業務の判断根拠と、担当者を選んだ理由を1〜2文で簡潔に"',
    '}',
    '',
    '業務メールと判定したのに宛先・振り分けルール・既定担当のいずれにも本当に当てはまらない、という極めて例外的な場合に限り、無理に割り当てず assignee を null にしてください（後で担当者が手動で設定します）。',
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

  let res
  let lastErr
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    res = await fetch(API_ENDPOINT, {
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
    if (res.ok) break

    const text = await res.text()
    const err = new Error(`Claude API エラー (${res.status}): ${text}`)
    // クレジット残高不足の検知（残高ゼロ時は 400 で "credit balance is too low" 等が返る）
    if (res.status === 402 || (res.status === 400 && /credit balance|billing|insufficient|too low/i.test(text))) {
      err.isBillingError = true
      throw err
    }
    lastErr = err
    const isLastAttempt = attempt === MAX_ATTEMPTS - 1
    if (!RETRYABLE_STATUS.has(res.status) || isLastAttempt) throw err
    await sleep(RETRY_DELAY_MS[attempt] || RETRY_DELAY_MS[RETRY_DELAY_MS.length - 1])
  }
  if (!res.ok) throw lastErr

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

// 違反車両の写真からナンバープレート・車種を読み取る（2026-08-05〜。手動トリガー式）。
// FAX読み取りと同じ考え方で、判読できない項目は推測せず null を返させる。
export async function recognizeVehicle(imageBase64, mediaType) {
  const { ANTHROPIC_API_KEY } = process.env
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY が設定されていません')
  }
  const model = process.env.CLAUDE_MODEL || DEFAULT_MODEL

  const system = [
    'あなたは駐車違反車両の記録を補助するアシスタントです。',
    '与えられた車両の写真を見て、ナンバープレートと車種を読み取り、指定のJSON形式のみで回答してください。説明文やコードフェンスは不要です。',
    '',
    '【重要: 読み取れないときに創作しないこと】',
    '文字が不鮮明・低解像度・撮影角度・被写体が写っていない等で自信を持って読み取れない項目は、推測や創作をせず必ず null にしてください。',
    '誤った情報を記録すると実害があるため、確実に判読できた項目だけを埋めてください。',
    '',
    '【出力JSONの形式】',
    '{',
    '  "plate_region": "ナンバープレート上部の地名（例: 広島、なにわ、品川）。読み取れなければ null",',
    '  "plate_number": "ナンバープレート下段の一連指定番号を「-」なしの数字のみで（例: 1234）。分類番号やひらがな部分は含めない。読み取れなければ null",',
    '  "maker": "車両メーカー名（例: トヨタ、ホンダ、日産）。判別できなければ null",',
    '  "model": "車種名（例: プリウス、フィット）。判別できなければ null"',
    '}',
    '',
    '必ず有効なJSONのみを返してください。',
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
      max_tokens: 300,
      system,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: '添付の写真からナンバープレートと車種を読み取ってください。' },
          ],
        },
      ],
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    const err = new Error(`Claude API エラー (${res.status}): ${text}`)
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
  return { result: parsed, usage }
}
