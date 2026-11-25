// 休館日の判定（2026-11-25〜。日曜・祝日を自動で休館日にする）
//
// 休館日は closed_days テーブル（手で「休館日」にした日）に加えて、次の「自動の休館日」も含める。
//   ・AUTO_CLOSED_WEEKDAYS の曜日（既定は日曜）と国民の祝日（holidays-jp の静的JSON。無料）
//   ・ただし、その日に日報か自主検査表の記録がある日（＝開館して業務をした日）は除く
//   ・「休館日を解除」した日（settings の report_open_days）も除く＝例外的に開館する日
// 自動の休館日は closed_days に行を作らない（DB変更なし）。解除は settings の1キーに日付の
// 配列で持つ（chlorine_bkb_injection_levels と同じ方式。SQL Editor での作業を不要にするため）。
// 日報一覧・自主検査表・ダッシュボード・会議室予約表・eWorks の予定作成がすべてここを通る。
import { fetchHolidays } from './holidays.js'

// 自動で休館日にする曜日（0=日曜〜6=土曜）
export const AUTO_CLOSED_WEEKDAYS = [0]
export const OPEN_DAYS_KEY = 'report_open_days'
const OPEN_DAYS_MAX = 2000

function eachDate(from, to) {
  const out = []
  const d = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

// その日が自動の休館日の対象（AUTO_CLOSED_WEEKDAYS の曜日・祝日）か
export function isAutoClosedCandidate(date, holidays = {}) {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
  return AUTO_CLOSED_WEEKDAYS.includes(dow) || Boolean(holidays[date])
}

// settings の「休館日を解除した日」一覧（Set）
export async function loadOpenDays(supabase) {
  const { data, error } = await supabase.from('settings').select('value').eq('key', OPEN_DAYS_KEY).maybeSingle()
  if (error) throw error
  try {
    const parsed = JSON.parse(data?.value || '{}')
    return new Set((parsed.dates || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))
  } catch {
    return new Set()
  }
}

async function saveOpenDays(supabase, set, userId) {
  const dates = [...set].sort().slice(-OPEN_DAYS_MAX)
  const value = JSON.stringify({ dates, updated_at: new Date().toISOString(), updated_by: userId || null })
  const { error } = await supabase.from('settings').upsert({ key: OPEN_DAYS_KEY, value }, { onConflict: 'key' })
  if (error) throw error
}

// 「休館日を解除」した日として記録する／その記録を消す（休館日に戻すとき）
export async function setOpenDay(supabase, date, open, userId) {
  const set = await loadOpenDays(supabase)
  if (open === set.has(date)) return
  if (open) set.add(date)
  else set.delete(date)
  await saveOpenDays(supabase, set, userId)
}

// [from, to]（両端を含む 'YYYY-MM-DD'）の休館日を昇順の配列で返す
export async function closedDaysInRange(supabase, from, to) {
  const [closedRes, reportRes, inspRes, openDays, holidays] = await Promise.all([
    supabase.from('closed_days').select('closed_on').gte('closed_on', from).lte('closed_on', to),
    supabase.from('daily_reports').select('report_date').gte('report_date', from).lte('report_date', to),
    supabase.from('fire_inspections').select('inspected_on').gte('inspected_on', from).lte('inspected_on', to),
    loadOpenDays(supabase),
    // 祝日が取れないときは曜日だけで判定する（祝日は手で休館日にできる）
    fetchHolidays().catch((err) => {
      console.error('closed-days holidays:', err?.message || err)
      return {}
    }),
  ])
  for (const r of [closedRes, reportRes, inspRes]) if (r.error) throw r.error
  const worked = new Set([
    ...(reportRes.data || []).map((r) => r.report_date),
    ...(inspRes.data || []).map((r) => r.inspected_on),
  ])
  const out = new Set((closedRes.data || []).map((r) => r.closed_on))
  for (const date of eachDate(from, to)) {
    if (out.has(date) || worked.has(date) || openDays.has(date)) continue
    if (isAutoClosedCandidate(date, holidays)) out.add(date)
  }
  return [...out].sort()
}
