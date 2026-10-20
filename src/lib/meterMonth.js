// 検針一覧・値の入力で使う、月度ごとの行の組み立て（2026-10-20〜。docs/meter-plan.md 5章）。
// 並びは出力（検針データ_yyyy年mm月分）と同じ: テナントの階 → 請求先コード → メータの階 → 連番 → メータ番号
import { readingUsage, shiftMonth } from './meterOutput'
import { activeMeters, latestPhotoByMeter } from './meter'

// 前月比（当月の使用量 ÷ 前月の使用量）がこの範囲の外なら、一覧で黄色にして確かめてもらう
export const RATIO_WARN_HIGH = 1.5
export const RATIO_WARN_LOW = 0.5

function compareRows(a, b) {
  const key = (x) => [
    x.tenant ? 0 : 1,
    x.tenant?.floor || '',
    x.tenant?.billing_code || '',
    x.meter.floor || '',
    x.meter.seq ?? -1,
    x.meter.meter_no || '',
  ]
  const ka = key(a)
  const kb = key(b)
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return -1
    if (ka[i] > kb[i]) return 1
  }
  return 0
}

/**
 * @param {{ month: string, tenants: object[], meters: object[], readings: object[], photos: object[] }} data
 * @returns 検針対象のメータごとの行（写真・当月と前月の値・使用量・前月比・要確認か）
 */
export function buildMonthRows(data) {
  const { month } = data
  const prevMonth = shiftMonth(month, -1)
  const prev2Month = shiftMonth(month, -2)
  const tenantById = new Map(data.tenants.map((t) => [t.id, t]))
  const readingOf = new Map(data.readings.map((r) => [`${r.meter_id}|${r.month}`, r]))
  const photoOf = latestPhotoByMeter(data.photos)
  const photoCount = new Map()
  for (const p of data.photos) if (p.meter_id) photoCount.set(p.meter_id, (photoCount.get(p.meter_id) || 0) + 1)

  return activeMeters(data.meters)
    .map((meter) => {
      const reading = readingOf.get(`${meter.id}|${month}`) || null
      const prevReading = readingOf.get(`${meter.id}|${prevMonth}`) || null
      const prev2Reading = readingOf.get(`${meter.id}|${prev2Month}`) || null
      const entered = reading?.value != null
      // 当月が未入力でも前月値は見せる（入力の目安になる）
      const usage = readingUsage(reading || { value: null }, prevReading, meter)
      const prevUsage = prevReading ? readingUsage(prevReading, prev2Reading, meter) : null
      const total = entered ? usage.diff + (meter.is_oa_meter ? usage.diff2 : 0) : null
      const prevTotal = prevUsage ? prevUsage.diff + (meter.is_oa_meter ? prevUsage.diff2 : 0) : null
      const ratio = total != null && prevTotal ? total / prevTotal : null
      const unusual = ratio != null && (ratio >= RATIO_WARN_HIGH || ratio <= RATIO_WARN_LOW)
      return {
        meter,
        tenant: meter.tenant_id ? tenantById.get(meter.tenant_id) || null : null,
        reading,
        prevReading,
        usage,
        total,
        prevTotal,
        ratio,
        unusual,
        entered,
        // FileMaker から移した月は確かめ済みとして扱う（確認者の記録が無いため）
        verified: !!reading?.verified_at || !!reading?.legacy_id,
        photo: photoOf[meter.id] || null,
        photoCount: photoCount.get(meter.id) || 0,
      }
    })
    .sort(compareRows)
}

// 一覧の進捗（写真あり・入力済み・確認済み）
export function monthProgress(rows) {
  return {
    total: rows.length,
    photos: rows.filter((r) => r.photo).length,
    entered: rows.filter((r) => r.entered).length,
    verified: rows.filter((r) => r.verified).length,
  }
}

// 写真の撮影日時（UTC の ISO）→ 日本時間の検針日付・時刻
export function jstDateTime(iso) {
  if (!iso) return null
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString()
  return { date: d.slice(0, 10), time: d.slice(11, 19) }
}

// 表示用: 'M/D HH:MM'
export function formatTaken(iso) {
  const t = jstDateTime(iso)
  if (!t) return ''
  const [, m, d] = t.date.split('-')
  return `${Number(m)}/${Number(d)} ${t.time.slice(0, 5)}`
}

// 数値の表示（小数は第2位まで。外調機は小数を持つ）
export function formatValue(n) {
  if (n == null || n === '') return ''
  const v = Number(n)
  if (!Number.isFinite(v)) return ''
  return Number.isInteger(v) ? v.toLocaleString('ja-JP') : v.toLocaleString('ja-JP', { maximumFractionDigits: 2 })
}

export function formatRatio(r) {
  if (r == null) return ''
  return `${Math.round(r * 100)}%`
}
