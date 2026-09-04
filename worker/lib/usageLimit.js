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

// 100万トークンあたりの単価（USD）。**src/lib/pricing.js と同じ値を保つこと**
// （フロントは画面表示用、ここは停止判定用。Workerからsrc/を参照できないため重複している）
const PRICING_USD_PER_MTOK = { input: 1.0, output: 5.0 }

// 上限の既定値。実績は平常0.06〜0.08ドル/日のため、通常運用では絶対に当たらない値にしてある
export const DEFAULT_DAILY_COST_LIMIT_USD = 0.5

export function estimateCostUSD(inputTokens, outputTokens) {
  return (
    (Number(inputTokens || 0) / 1_000_000) * PRICING_USD_PER_MTOK.input +
    (Number(outputTokens || 0) / 1_000_000) * PRICING_USD_PER_MTOK.output
  )
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

// 本日の利用量を取得する。行が無ければ 0 とみなす
export async function fetchTodayUsage(supabase) {
  const day = todayJSTDate()
  const { data, error } = await supabase
    .from('api_usage_daily')
    .select('input_tokens, output_tokens, calls')
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
  return { input, output, calls: Number(data?.calls || 0), costUSD: estimateCostUSD(input, output), unknown: false }
}

// 本日分に加算し、加算後の合計を返す（呼び出し側が即座に上限判定できるようにする）
export async function addTodayUsage(supabase, { input = 0, output = 0, calls = 0 }) {
  const { data, error } = await supabase.rpc('add_api_usage_daily', {
    p_day: todayJSTDate(),
    p_input: input,
    p_output: output,
    p_calls: calls,
  })
  if (error) {
    console.error('add_api_usage_daily に失敗:', error.message)
    return null
  }
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return null
  const totalInput = Number(row.input_tokens || 0)
  const totalOutput = Number(row.output_tokens || 0)
  return { input: totalInput, output: totalOutput, calls: Number(row.calls || 0), costUSD: estimateCostUSD(totalInput, totalOutput) }
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
