// 検針管理: FileMaker の CSV 5本（meterCsv.js で読んだもの）を、取込・照合に使える形にそろえる
// （2026-10-20〜。docs/meter-plan.md 8章 Phase 1）。
//
// - メータの請求先コードからテナントを引く（コードの無いメータは空室・未割当）
// - マスタに無いメータ番号の検針値（バーコードの読み違いなど）は取り込まない
// - 同じメータ・同じ月度の検針値が2件あるとき（2019〜2020年に4件）は、後から作った方を残す
// 結果の id は FileMaker の主キー（取込先の DB ではサーバー側で本物の id に引き直す）。

function byLatestCreated(a, b) {
  return (a.created_at || '').localeCompare(b.created_at || '')
}

export function prepareMigration({ tenants = [], meters = [], readings = [], ac_units = [], ac_usage = [] }) {
  const warnings = []

  const tenantRows = tenants.map((t) => ({ ...t, id: t.legacy_id }))
  const tenantByCode = new Map(tenantRows.filter((t) => t.billing_code).map((t) => [t.billing_code, t]))

  const meterRows = meters.map((m) => {
    const tenant = m.billing_code ? tenantByCode.get(m.billing_code) : null
    if (m.billing_code && !tenant) warnings.push(`メータ ${m.meter_no} の請求先コード ${m.billing_code} がテナントマスタにありません`)
    return { ...m, id: m.legacy_id, tenant_id: tenant?.id || null }
  })
  const meterByNo = new Map(meterRows.map((m) => [m.meter_no, m]))

  let unknownMeter = 0
  const latest = new Map()
  let duplicates = 0
  for (const r of readings) {
    const meter = r.meter_no ? meterByNo.get(r.meter_no) : null
    if (!meter || !r.month || !r.read_on) {
      unknownMeter++
      continue
    }
    const key = `${meter.id}\u0000${r.month}`
    const prev = latest.get(key)
    if (prev) {
      duplicates++
      if (byLatestCreated(prev, r) > 0) continue
    }
    latest.set(key, { ...r, id: r.legacy_id, meter_id: meter.id })
  }
  if (unknownMeter) warnings.push(`メータ番号が空かマスタに無い検針値 ${unknownMeter}件は取り込みません（バーコードの読み違いなど）`)
  if (duplicates) warnings.push(`同じメータ・同じ月度の検針値 ${duplicates}件は、後から作られた方だけを残します`)

  const acUnits = ac_units
    .filter((u) => u.unit_no != null)
    .map((u) => ({ ...u, meter_id: u.meter_no ? meterByNo.get(u.meter_no)?.id || null : null }))

  const usage = new Map()
  for (const u of ac_usage) {
    if (u.unit_no == null || !u.month) continue
    usage.set(`${u.month}\u0000${u.unit_no}`, u)
  }
  if (usage.size !== ac_usage.length) warnings.push(`空調データの重複・不備 ${ac_usage.length - usage.size}件を除きました`)

  return {
    tenants: tenantRows,
    meters: meterRows,
    readings: [...latest.values()],
    acUnits,
    acUsage: [...usage.values()],
    warnings,
  }
}
