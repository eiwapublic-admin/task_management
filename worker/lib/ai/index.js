// AI提供元の切り替え口。**呼び出し側はここだけを import する**。
// 2026-09-05 新設（docs/ai-cost-and-alternatives.md 11章 Phase 1）。
//
// ねらい:
//   - Anthropic（Claude）と Gemini を **設定値 `settings.ai_provider` で切り替えられる**ようにする
//   - 現行の Anthropic 実装は削除も改変もしない。いつでも元に戻せる状態を保つ
//   - プロンプトの文面（= 1年かけて調整してきた資産）は `./prompts.js` に集約し、
//     提供元を替えても同じ文面を使う
//
// **2026-09-05 時点では Anthropic のみ実装済み**。`ai_provider` に未実装の値を入れても
// 既定（anthropic）で動くだけで、業務は止まらない（resolveProvider のフォールバック）。
// Gemini 実装（`./gemini.js`）は Phase 2 で追加し、下の PROVIDER_IMPLS に足す。
//
// 呼び出し側の使い方（provider は settings.ai_provider を渡すだけ。省略時は既定）:
//   const { classification, usage } = await classifyEmail(email, context, docs, provider)

import * as anthropic from './anthropic.js'
import { resolveProvider, defaultModelOf, estimateCostUSD } from './pricing.js'

const PROVIDER_IMPLS = {
  anthropic,
  // gemini,  ← Phase 2
}

function implOf(provider) {
  const key = resolveProvider(provider)
  return PROVIDER_IMPLS[key] || PROVIDER_IMPLS.anthropic
}

// メール1通を分類する（業務外判定・担当者・期限・添付の読み取り等）。
// 戻り値の形は提供元によらず { classification, usage: { input_tokens, output_tokens } }。
export function classifyEmail(email, context, documents = [], provider = null) {
  return implOf(provider).classifyEmail(email, context, documents)
}

// 違反車両の写真からナンバープレート・車種を読み取る。戻り値 { result, usage }
export function recognizeVehicle(imageBase64, mediaType, provider = null) {
  return implOf(provider).recognizeVehicle(imageBase64, mediaType)
}

// 廃棄物実測集計表の写真から日ごと・階ごとの実測値を読み取る。戻り値 { days, usage }
export function recognizeWasteSheet(imageBase64, mediaType, options, provider = null) {
  return implOf(provider).recognizeWasteSheet(imageBase64, mediaType, options)
}

// 提供元まわりのユーティリティ（利用量の記録・画面表示で使う）
export { resolveProvider, defaultModelOf, estimateCostUSD }
