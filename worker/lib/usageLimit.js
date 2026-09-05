// Claude API のサーキットブレーカー（1日あたりの上限で自動停止）。2026-09-04 新設。
//
// 経緯: 業務外と判定したメールを毎回再分類していた不具合により、平常$0.07/日のところ
// 9/3に$1.27・9/4に$1.37を消費し、$5のクレジットを枯渇させた（HANDOFF 219番）。
// 原因そのものは修正済みだが、同種の暴走が再発しても被害額が青天井にならないよう、
// 「1日あたりいくらまで」の上限を設けて超えたら自動的にAI処理を止める。
//
// 判定はコスト（USD）で行う。件数ではなく金額にしているのは、添付PDF・画像の有無で
// 1件あたりのトークン数が2桁変わるため、件数上限では歯止めにならないから。

import { notifyApiAlert } from './push.js'
import { estimateCostUSD as estimateProviderCostUSD, DEFAULT_PROVIDER } from './ai/pricing.js'

// 上限の既定値。実績は平常0.06〜0.08ドル/日のため、通常運用では絶対に当たらない値にしてある
export const DEFAULT_DAILY_COST_LIMIT_USD = 0.5

// トークン数からの推定（2026-09-05以降は原則使わない。下記 fetchTodayUsage 参照）。
// 提供元を明示しない呼び出しは既定（Anthropic）の単価で計算する。
export function estimateCostUSD(inputTokens, outputTokens, provider = DEFAULT_PROVIDER) {
  return estimateProviderCostUSD(provider, inputTokens, outputTokens)
}

// 上限値の解釈。0以下・数値でない値は「上限なし」ではなく既定値に倒す
// （設定ミスで歯止めが外れるより、既定の上限で止まる方が安全）。
export function parseDailyLimitUSD(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAILY_COST_LIMIT_USD
  return n
}

// JST基準の当日（'YYYY-MM-DD'）。日付境界は業務の感覚に合わせて日本時間にする
export function todayJSTDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
}

// 本日の利用量を取得する。行が無ければ 0 とみなす。
// 金額は **加算時に確定させて保存した cost_usd** を読む（2026-09-05）。
// トークン数から都度計算する方式だと、AI提供元を切り替えた日・混在した日の金額が
// 出せない（提供元ごとに単価が1桁違う）。docs/ai-cost-and-alternatives.md 11-4。
export async function fetchTodayUsage(supabase) {
  const day = todayJSTDate()
  const { data, error } = await supabase
    .from('api_usage_daily')
    .select('input_tokens, output_tokens, calls, cost_usd')
    .eq('day', day)
    .maybeSingle()
  if (error) {
    // 取得できないときは「上限に達していない」として通す。ここで止めると、
    // 一時的なDB障害だけで全機能が停止してしまうため（課金の暴走は別途、
    // 加算側の記録で検知できる）
    console.error('api_usage_daily の取得に失敗:', error.message)
    return { input: 0, output: 0, calls: 0, costUSD: 0, unknown: true }
  }
  const input = Number(data?.input_tokens || 0)
  const output = Number(data?.output_tokens || 0)
  return { input, output, calls: Number(data?.calls || 0), costUSD: Number(data?.cost_usd || 0), unknown: false }
}

// 本日分に加算し、加算後の合計を返す（呼び出し側が即座に上限判定できるようにする）。
// costUSD を渡さなかった場合は、その場で provider の単価から計算して記録する
// （金額は必ず「加算した時点の単価」で確定させる。2026-09-05）。
export async function addTodayUsage(supabase, { input = 0, output = 0, calls = 0, costUSD = null, provider = DEFAULT_PROVIDER }) {
  const cost = costUSD === null ? estimateProviderCostUSD(provider, input, output) : Number(costUSD) || 0
  const { data, error } = await supabase.rpc('add_api_usage_daily', {
    p_day: todayJSTDate(),
    p_input: input,
    p_output: output,
    p_calls: calls,
    p_cost: cost,
  })
  if (error) {
    console.error('add_api_usage_daily に失敗:', error.message)
    return null
  }
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return null
  const totalInput = Number(row.input_tokens || 0)
  const totalOutput = Number(row.output_tokens || 0)
  return {
    input: totalInput,
    output: totalOutput,
    calls: Number(row.calls || 0),
    costUSD: Number(row.cost_usd || 0),
  }
}

// 本日の上限に達しているか。達している場合はメッセージも返す
export async function checkDailyLimit(supabase, limitRaw) {
  const limitUSD = parseDailyLimitUSD(limitRaw)
  const usage = await fetchTodayUsage(supabase)
  const exceeded = !usage.unknown && usage.costUSD >= limitUSD
  return {
    exceeded,
    limitUSD,
    usage,
    message: exceeded
      ? `本日のAI利用が上限（$${limitUSD.toFixed(2)}）に達したため、AI処理を停止しました（本日の推定利用額 $${usage.costUSD.toFixed(2)}）。設定画面の「AI利用の1日あたり上限」で変更できます。`
      : '',
  }
}

// 上限到達の記録（画面のバナー表示用）。日付を持たせて、翌日になったら自動的に消えるようにする。
// あわせて端末へプッシュ通知する（2026-09-04。依頼）。ただし**その日の最初の1回だけ**送る
// （巡回のたび・手動読み取りのたびに鳴り続けるのを防ぐ。記録済みの day が本日なら送らない）。
export async function setLimitAlert(supabase, message) {
  const day = todayJSTDate()

  let notifiedToday = false
  const { data } = await supabase.from('settings').select('value').eq('key', 'api_limit_alert').maybeSingle()
  try {
    const prev = JSON.parse(data?.value || 'null')
    notifiedToday = prev?.day === day
  } catch {
    notifiedToday = false
  }

  await supabase.from('settings').upsert(
    { key: 'api_limit_alert', value: JSON.stringify({ message, day, at: new Date().toISOString() }) },
    { onConflict: 'key' }
  )

  if (!notifiedToday) {
    await notifyApiAlert({
      title: 'AI利用が1日の上限に達しました',
      body: `${message} 業務メールの自動分類も停止しています。`,
      url: '/usage',
    })
  }
}

export async function clearLimitAlert(supabase) {
  await supabase.from('settings').upsert({ key: 'api_limit_alert', value: '' }, { onConflict: 'key' })
}
