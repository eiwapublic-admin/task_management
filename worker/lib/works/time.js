// 勤怠管理（eWorks）の時間の計算（docs/eworks-spec-time.md）。
// Worker と画面の両方から使う（画面は src/works から相対パスで読み込む）。副作用のない関数だけを置く。

// 'HH:MM' または 'HH:MM:SS' → 0 時からの分
export function toMin(t) {
  if (!t) return null
  const [h, m] = String(t).split(':').map(Number)
  return h * 60 + m
}

export function fromMin(n) {
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
}

// 休憩（分）。1-2 の規則:
//   ・その曜日の例外休憩があればその時間
//   ・なければ、休憩時間帯をまるごと含む（開始が帯の開始より前、終了が帯の終了より後）帯だけを差し引く
export function breakMinutes(start, end, { windows = [], override = null } = {}) {
  const s = toMin(start)
  const e = toMin(end)
  if (override) return Math.max(0, toMin(override.end) - toMin(override.start))
  let total = 0
  for (const w of windows) {
    const ws = toMin(w.start)
    const we = toMin(w.end)
    if (s < ws && e > we) total += we - ws
  }
  return total
}

// 1 件の時間（分）と警告
export function shiftMinutes(start, end, opts) {
  const brk = breakMinutes(start, end, opts)
  const span = toMin(end) - toMin(start)
  const minutes = Math.max(0, span - brk)
  // 労基法: 6 時間を超える勤務には 45 分以上の休憩が要る（spec-time 3 章の提案）
  const warnNoBreak = span > 360 && brk < 45
  return { minutes, breakMinutes: brk, warnNoBreak }
}

// 分 → 「7.5」のような時間の表記（小数 2 桁まで、末尾の 0 は省く）
export function hoursLabel(min) {
  return String(Math.round((min / 60) * 100) / 100)
}

// 'YYYY-MM' の月の初日と末日（'YYYY-MM-DD'）
export function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}`, days: last }
}

// 日付の曜日（0=日）。タイムゾーンに左右されないよう UTC で計算する
export function dow(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

// 日本時間の今日（'YYYY-MM-DD'）
export function todayJst(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// 打刻の採用時刻（docs/eworks-plan.md 6-5。決定 2026-11-16）
//   出勤 = 打刻を 30 分刻みへ切り上げ、予定の開始より早ければ予定の開始
//   退勤 = 打刻を 30 分刻みへ切り捨て、予定の終了より遅ければ予定の終了
//   予定がない日は丸めた時刻のまま
// ---------------------------------------------------------------------------
export function roundUp(min, unit = 30) {
  return Math.ceil(min / unit) * unit
}
export function roundDown(min, unit = 30) {
  return Math.floor(min / unit) * unit
}

// kind: 'in' | 'out'、punch: 'HH:MM'、plan: { plan_start, plan_end } | null → 'HH:MM'
export function adoptedTime(kind, punch, plan, unit = 30) {
  const p = toMin(punch)
  if (kind === 'in') {
    let t = Math.min(roundUp(p, unit), 24 * 60 - unit)
    if (plan) t = Math.max(t, toMin(plan.plan_start))
    return fromMin(t)
  }
  let t = roundDown(p, unit)
  if (plan) t = Math.min(t, toMin(plan.plan_end))
  return fromMin(t)
}

// Date → 日本時間の { date: 'YYYY-MM-DD', time: 'HH:MM' }
export function jstParts(d) {
  const j = new Date(d.getTime() + 9 * 3600e3).toISOString()
  return { date: j.slice(0, 10), time: j.slice(11, 16) }
}

// 2 点間の距離（メートル）
export function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const rad = (x) => (x * Math.PI) / 180
  const dLat = rad(lat2 - lat1)
  const dLng = rad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(a)))
}
