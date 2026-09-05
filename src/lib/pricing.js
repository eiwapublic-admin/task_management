// AI利用の推定コスト計算（当システムが計測したトークン数から試算）。
// 実際の請求は提供元（Anthropic 等）の確定値が正だが、このAPIキーは本システム専用のため
// ほぼ実利用額と一致する。表示はあくまで「目安」として扱う。
//
// 2026-09-05: 金額は **加算時に確定させて `api_usage.cost_usd` に保存する**方式へ変更した
// （AI提供元を切り替えた月・混在した月でも正しい金額を出すため。
//  docs/ai-cost-and-alternatives.md 11-4）。画面は `rowCostUSD()` を使い、
//  cost_usd を持たない古い行だけ従来どおりトークン数から試算する。

// 100万トークンあたりの単価（USD）。**worker/lib/ai/pricing.js と同じ値を保つこと**。
// モデル追加時はここに足す。
export const PRICING_USD_PER_MTOK = {
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
}

const DEFAULT_MODEL = 'claude-haiku-4-5'

// 円換算の目安レート（為替は変動するため「目安」表示に留める）
export const USD_JPY = 155

export function estimateCostUSD(inputTokens, outputTokens, model = DEFAULT_MODEL) {
  const p = PRICING_USD_PER_MTOK[model] || PRICING_USD_PER_MTOK[DEFAULT_MODEL]
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output
}

// 1行ぶんの金額。記録済みの cost_usd があればそれを使う（提供元ごとの単価差を吸収する）。
// 無い（=移行前の行、または記録に失敗した行）ときだけトークン数から試算する。
export function rowCostUSD(row) {
  const recorded = Number(row?.cost_usd)
  if (Number.isFinite(recorded) && recorded > 0) return recorded
  return estimateCostUSD(Number(row?.input_tokens || 0), Number(row?.output_tokens || 0))
}

export function formatUSD(value) {
  return `$${value.toFixed(2)}`
}

export function formatJPY(usd) {
  return `約¥${Math.round(usd * USD_JPY).toLocaleString('ja-JP')}`
}

export const BILLING_URL = 'https://console.anthropic.com/settings/billing'
