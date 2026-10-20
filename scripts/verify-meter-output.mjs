// 検針: FileMaker から書き出した CSV 5本だけで「検針データ_yyyy年mm月分」を組み立て、
// FileMaker が出した xlsx と全セルを突き合わせる（docs/meter-plan.md 4章「移行の合格条件」）。
// 取込画面（src/lib/meterCsv.js）と出力（src/lib/meterOutput.js）は本番と同じ関数を使う。
//
// 使い方:
//   python3 scripts/dump-xlsx-json.py 検針データ_2026年10月分.xlsx > /tmp/expected.json
//   node scripts/verify-meter-output.mjs <CSVのフォルダ> /tmp/expected.json 2026-10 [--recompute]
// --recompute を付けると、移行した前月値・差分を使わずアプリの計算だけで組み立てる
// （アプリで入力した月と同じ計算になるかの確認用）。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readMigrationCsv } from '../src/lib/meterCsv.js'
import { buildMeterOutput, METER_OUTPUT_COLUMNS } from '../src/lib/meterOutput.js'
import { prepareMigration } from '../src/lib/meterMigration.js'

const [dir, expectedPath, month, ...flags] = process.argv.slice(2)
if (!dir || !expectedPath || !/^\d{4}-\d{2}$/.test(month || '')) {
  console.error('使い方: node scripts/verify-meter-output.mjs <CSVのフォルダ> <expected.json> YYYY-MM [--recompute]')
  process.exit(1)
}
const recompute = flags.includes('--recompute')

const files = {}
for (const name of readdirSync(dir)) {
  if (!name.toLowerCase().endsWith('.csv')) continue
  try {
    const parsed = readMigrationCsv(readFileSync(join(dir, name), 'utf8'))
    files[parsed.kind] = parsed.records
  } catch {
    // FileMaker の CSV でないものは無視する
  }
}

const data = prepareMigration(files)
for (const w of data.warnings) console.log(`注意: ${w}`)
const readings = data.readings
  .filter((r) => r.month === month || r.month === shiftBack(month))
  .map((r) =>
    recompute
      ? { ...r, legacy_prev: null, legacy_prev2: null, legacy_diff: null, legacy_diff2: null }
      : r
  )
const out = buildMeterOutput({
  month,
  tenants: data.tenants,
  meters: data.meters,
  readings,
  acUsage: data.acUsage.filter((u) => u.month === month),
  oaCoefficient: 40,
})

function shiftBack(m) {
  const [y, mm] = m.split('-').map(Number)
  return mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, '0')}`
}

const expected = JSON.parse(readFileSync(expectedPath, 'utf8'))
const [head, ...rows] = expected
const problems = []
if (JSON.stringify(head) !== JSON.stringify(METER_OUTPUT_COLUMNS)) problems.push('見出しが違う')
if (rows.length !== out.rows.length) problems.push(`行数が違う（期待 ${rows.length}・出力 ${out.rows.length}）`)

const same = (a, b) => {
  if (a == null || b == null) return a == null && b == null
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b)
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9
  return a === b
}
let cells = 0
for (let i = 0; i < Math.max(rows.length, out.rows.length); i++) {
  const e = rows[i] || []
  const o = out.rows[i] || []
  for (let c = 0; c < METER_OUTPUT_COLUMNS.length; c++) {
    cells++
    if (!same(e[c], o[c])) {
      problems.push(`${i + 2}行目 ${c + 1}列（${METER_OUTPUT_COLUMNS[c]}）: 期待 ${JSON.stringify(e[c])} / 出力 ${JSON.stringify(o[c])}（メータ ${o[2] ?? e[2]}）`)
    }
  }
}
console.log(`${month}${recompute ? '（再計算）' : ''}: ${out.rows.length}行 × ${METER_OUTPUT_COLUMNS.length}列 = ${cells}セルを照合`)
if (problems.length === 0) {
  console.log('全セル一致')
} else {
  console.log(`不一致 ${problems.length}件`)
  for (const p of problems.slice(0, 80)) console.log(`  ${p}`)
  process.exitCode = 1
}
