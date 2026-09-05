// AI提供元・モデルごとの単価（100万トークンあたりのUSD）と、コストの試算。
// 2026-09-05 新設（docs/ai-cost-and-alternatives.md 11章）。
//
// **`src/lib/pricing.js`（画面表示用）と値を揃えること。** Workerからは src/ を
// 参照できないため重複しているが、片方だけ直すと画面の金額と停止判定がずれる。
//
// 単価は「出力＝思考トークンを含む」ことに注意（Gemini の料金表の定義）。
// Gemini を使う場合は thinking を最小/オフに明示設定すること（同11-9）。

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic（Claude）',
    defaultModel: 'claude-haiku-4-5',
    // 2026-08 時点の公式価格。src/lib/pricing.js と一致していることを確認済み
    models: {
      'claude-haiku-4-5': { input: 1.0, output: 5.0 },
    },
  },
  // Phase 2 で実装を足す枠（2026-09-05 時点では未実装。単価は公式の料金ページで確認済み）
  //   gemini-3.1-flash-lite : $0.25 / $1.50
  //   gemini-3.5-flash-lite : $0.30 / $2.50
}

// 既定の提供元。settings.ai_provider が未設定・不正なときはここに倒す
export const DEFAULT_PROVIDER = 'anthropic'

// 設定値から提供元を決める。未実装・未知の値は既定へフォールバックする
// （設定ミスでAI処理が丸ごと止まるより、従来どおり動く方が安全）。
export function resolveProvider(raw) {
  const key = String(raw || '').trim().toLowerCase()
  if (key && Object.prototype.hasOwnProperty.call(PROVIDERS, key)) return key
  return DEFAULT_PROVIDER
}

// 提供元の既定モデル名（利用量の記録・画面表示に使う）
export function defaultModelOf(provider) {
  return (PROVIDERS[resolveProvider(provider)] || PROVIDERS[DEFAULT_PROVIDER]).defaultModel
}

// 単価を引く。モデル指定が無ければ提供元の既定モデル
export function ratesOf(provider, model = null) {
  const p = PROVIDERS[resolveProvider(provider)] || PROVIDERS[DEFAULT_PROVIDER]
  return p.models[model || p.defaultModel] || p.models[p.defaultModel]
}

// 推定コスト（USD）。**利用量を記録する時点でこの値を確定させて保存する**
// （提供元が混在した月でも金額が正しく出るようにするため。11-4）。
export function estimateCostUSD(provider, inputTokens, outputTokens, model = null) {
  const r = ratesOf(provider, model)
  return (Number(inputTokens || 0) / 1_000_000) * r.input + (Number(outputTokens || 0) / 1_000_000) * r.output
}
