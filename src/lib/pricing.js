// Claude API の推定コスト計算（当システムが計測したトークン数から試算）。
// 実際の請求は Anthropic 側の確定値が正だが、このAPIキーは本システム専用のため
// ほぼ実利用額と一致する。表示はあくまで「目安」として扱う。

// 100万トークンあたりの単価（USD）。モデル追加時はここに足す。
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

export function formatUSD(value) {
  return `$${value.toFixed(2)}`
}

export function formatJPY(usd) {
  return `約¥${Math.round(usd * USD_JPY).toLocaleString('ja-JP')}`
}

export const BILLING_URL = 'https://console.anthropic.com/settings/billing'
