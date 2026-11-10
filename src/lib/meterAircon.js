// 検針: 空調データ（集中コントローラの CSV）の画面用の整え（Phase 3。2026-11-10〜。docs/meter-plan.md 5章）

// CSV のファイルは Shift_JIS（cp932）。念のため UTF-8 で書き出したものも受ける
export function decodeAcCsv(buffer) {
  const bytes = new Uint8Array(buffer)
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (utf8.includes('開始日') && utf8.includes('空調機番号')) return utf8
  return new TextDecoder('shift_jis').decode(bytes)
}

// 'YYYY-MM' の月の日数
export function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

// 取り込む前の確かめ（期間が「月度の前月の1日〜末日」になっているか）
export function acCsvWarnings(parsed, pageMonth) {
  const warnings = []
  const usedMonth = parsed.periodStart.slice(0, 7)
  if (!parsed.periodStart.endsWith('-01')) warnings.push(`開始日が月の1日ではありません（${parsed.periodStart}）`)
  if (parsed.days !== daysInMonth(usedMonth)) {
    warnings.push(`日数が ${parsed.days}日です（${Number(usedMonth.slice(5))}月は ${daysInMonth(usedMonth)}日）`)
  }
  if (parsed.month !== pageMonth) warnings.push('いま開いている月度と違います（CSV の期間の月度で取り込みます）')
  return warnings
}

// 期間の表示（'2026-09-01', 30 → '2026/9/1〜9/30（30日）'）
export function periodLabel(start, days) {
  if (!start) return ''
  const d = new Date(`${start}T00:00:00Z`)
  const end = new Date(d.getTime() + Math.max(0, (days || 1) - 1) * 86400000)
  const f = (x, withYear) =>
    `${withYear ? `${x.getUTCFullYear()}/` : ''}${x.getUTCMonth() + 1}/${x.getUTCDate()}`
  return `${f(d, true)}〜${f(end, end.getUTCFullYear() !== d.getUTCFullYear())}${days ? `（${days}日）` : ''}`
}

/**
 * 空調データをメータごとにまとめる（FileMaker の「空調データ」画面と同じ見せ方）。
 * 合計と請求用（kWh、1000 で割って切り捨て）は出力（meterOutput.js）と同じ計算
 * @returns {{ groups: { meterNo, meter, tenant, wh, kwh, units }[], unassigned: object[], total: number, mismatched: number }}
 */
export function groupAcUsage({ usage, units, meters, tenants }) {
  const meterById = new Map(meters.map((m) => [m.id, m]))
  const meterByNo = new Map(meters.map((m) => [m.meter_no, m]))
  const tenantById = new Map(tenants.map((t) => [t.id, t]))
  const currentMeterNo = new Map(units.map((u) => [u.unit_no, u.meter_id ? meterById.get(u.meter_id)?.meter_no || null : null]))

  const byMeter = new Map()
  const unassigned = []
  let total = 0
  let mismatched = 0
  for (const u of usage) {
    total += u.day_wh || 0
    const now = currentMeterNo.has(u.unit_no) ? currentMeterNo.get(u.unit_no) : undefined
    const row = { ...u, currentMeterNo: now, changed: now !== undefined && (now || null) !== (u.meter_no || null) }
    if (row.changed) mismatched++
    if (!u.meter_no) {
      unassigned.push(row)
      continue
    }
    const g = byMeter.get(u.meter_no) || { meterNo: u.meter_no, wh: 0, units: [] }
    g.wh += u.day_wh || 0
    g.units.push(row)
    byMeter.set(u.meter_no, g)
  }
  const groups = [...byMeter.values()]
    .map((g) => {
      const meter = meterByNo.get(g.meterNo) || null
      return {
        ...g,
        meter,
        tenant: meter?.tenant_id ? tenantById.get(meter.tenant_id) || null : null,
        kwh: Math.floor(g.wh / 1000),
      }
    })
    .sort((a, b) => a.meterNo.localeCompare(b.meterNo, 'ja', { numeric: true }))
  return { groups, unassigned, total, mismatched }
}
