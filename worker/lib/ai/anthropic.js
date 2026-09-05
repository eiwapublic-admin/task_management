// Claude API（Anthropic Messages API）の呼び出し。
// 追加依存を避けるため fetch で直接叩く。
// コスト最適化のため既定モデルは claude-haiku-4-5（環境変数 CLAUDE_MODEL で上書き可）。
//
// 2026-09-05、`worker/lib/anthropic.js` からこの場所へ移設した（提供元を設定で
// 切り替えられるようにするためのリファクタ。docs/ai-cost-and-alternatives.md 11章）。
// **移設にあたってAPI呼び出しのロジックは一切変えていない**。プロンプトの文面だけを
// `./prompts.js` へ、JSON取り出しだけを `./json.js` へ切り出した。
// 呼び出し側は直接ここを import せず、`./index.js` 経由で使うこと。

import { buildSystemPrompt, VEHICLE_SYSTEM_PROMPT, buildWasteSystemPrompt } from './prompts.js'
import { extractJson } from './json.js'

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

  const system = VEHICLE_SYSTEM_PROMPT

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

// 廃棄物実測集計表（手書き。1ヶ月分・1〜7階×日次のマス目）の写真から実測値を読み取る
// （2026-09-03〜。手動トリガー式。docs/waste-plan.md）。ナンバープレート読み取りと同じ
// 「判読できないマスは推測せず null」という考え方。「合計」列・「合計」行は転記済みの
// 集計値であり実測値そのものではないため読み取らせない（アプリ側で日次値から計算する）。
export async function recognizeWasteSheet(imageBase64, mediaType, { month, floors }) {
  const { ANTHROPIC_API_KEY } = process.env
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY が設定されていません')
  }
  const model = process.env.CLAUDE_MODEL || DEFAULT_MODEL
  const floorList = floors.join('・')

  const system = buildWasteSystemPrompt({ month, floorList })

  const res = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: '添付の写真から、日ごと・階ごとの実測重量（kg）を読み取ってください。' },
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
  if (!parsed || typeof parsed.days !== 'object' || parsed.days === null) {
    throw new Error(`Claude の応答をJSONとして解釈できませんでした: ${text.slice(0, 200)}`)
  }
  const usage = {
    input_tokens: data.usage?.input_tokens || 0,
    output_tokens: data.usage?.output_tokens || 0,
  }
  return { days: parsed.days, usage }
}
