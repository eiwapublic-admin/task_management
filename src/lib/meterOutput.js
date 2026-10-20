// 検針管理: 「検針データ_yyyy年mm月分.xlsx」の中身（47列）を組み立てる（2026-10-20〜。
// docs/meter-plan.md 6章）。
//
// 後続の請求書Excel（小泉産業様の「提出用 新請求書サマリー」）は、このファイルを
// 「当月検針データ」シートに貼り付け、列の位置で値を拾う。だから列の順番・空欄と0の違い・
// 数値か文字列かまで、FileMaker の出力と同じにする必要がある。2026年10月分（移行データ）で
// 受領ファイルと全セル一致することを確かめてある（scripts/verify-meter-output.mjs）。
//
// FileMaker の計算フィールドは「参照するフィールドがすべて空なら計算しない（空のまま）」設定の
// ものが多く、空欄と0の出し分けはそれに合わせてある（各列のコメント参照）。
// 画面とサーバーの両方から使うため、DOM やブラウザ固有の API には頼らない。

// 出力の見出し（FileMaker の書き出しそのまま。列の順番を変えないこと）
export const METER_OUTPUT_COLUMNS = [
  'A20_テナントマスタ::階',
  '請求先コード_連番',
  'メータ番号',
  '部屋番号',
  '貸室_補足',
  'A20_検針記録データ::メーター値',
  'A20_検針記録データ::メーター値_2',
  'A20_検針記録データ::メーター値_前月',
  'A20_検針記録データ::メーター値_前月_2',
  'A20_検針記録データ::メーター値_差分',
  'A20_検針記録データ::メーター値_差分_2',
  '空調外調_合計',
  'A20_検針記録データ::検針月度',
  'A20_検針記録データ::検針年月_前月',
  'A20_検針記録データ::請求対象期間_自',
  'A20_検針記録データ::請求対象期間_至',
  'A20_検針記録データ::検針月度_Date',
  'A20_検針記録データ::検針日付',
  'A20_検針記録データ_前月::検針日付',
  '請求先コード',
  'A20_テナントマスタ::正式名称',
  'A20_テナントマスタ::略称',
  'A20_テナントマスタ::退去済み',
  'テナント内連番',
  '階',
  '貸室名',
  '請求明細補足',
  '部屋面積_m2',
  '部屋面積_坪',
  '検針内容',
  'メータシール表記',
  'flg_メーター計測対象',
  '外調機電気量の按分有無',
  'メーター桁数',
  '検針機撤去済み',
  '空調電力使用量_計',
  '空調電力使用量_請求用',
  '空調電力使用量_対象メータ数',
  '外調機電気量_当月',
  '外調機電気量_按分比率',
  '外調機電気量_按分量',
  '外調機電気量_請求用',
  'A20_テナントマスタ::c_入居月度',
  '請求先合算_メーター値',
  '請求先合算_空調外調_合計',
  'A20_検針記録データ::検針時刻',
  'A00_MainControl::g_外調データ係数',
]

// 日付・時刻のセル。xlsx に書くときに日付（時刻）型のセルにするための目印
export const dateCell = (iso) => (iso ? { type: 'date', value: iso } : null)
export const timeCell = (hms) => (hms ? { type: 'time', value: hms } : null)

// 'YYYY-MM' → 'YYYY年 M月'（FileMaker の表記。1桁の月は前に空白が入る）
export function fmMonthLabel(month) {
  const [y, m] = month.split('-')
  return `${y}年${String(Number(m)).padStart(2, ' ')}月`
}

export function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

function lastDayOf(month) {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

// 小数を含むメーター値（外調機は小数第2位まで）の引き算で出る誤差を落とす
function tidy(n) {
  return Math.round(n * 1e6) / 1e6
}

// 1件の検針値の「前月値・差分」（2系統）。FileMaker から移した月は保存値をそのまま使い、
// アプリで入力した月は前月の検針値から計算する（docs/meter-plan.md 4章）。
// 差分は「当月値 − 前月値」。当月値の方が小さければ桁数で一周したとみなす（Q5）。
// 「前月の修正」があればそれを前月値に、「修正差分値」があればそれを差分にする
export function readingUsage(reading, prevReading, meter) {
  const wrap = (d) => (d < 0 && meter?.digits ? d + 10 ** meter.digits : d)
  const prev =
    reading.legacy_prev ?? reading.prev_override ?? prevReading?.value ?? 0
  const prev2 = reading.legacy_prev2 ?? prevReading?.value2 ?? 0
  let diff = reading.legacy_diff
  if (diff == null) {
    if (reading.diff_override != null) diff = reading.diff_override
    else diff = reading.value == null ? 0 : tidy(wrap(reading.value - prev))
  }
  let diff2 = reading.legacy_diff2
  if (diff2 == null) diff2 = reading.value2 == null ? 0 : tidy(wrap(reading.value2 - prev2))
  return { prev, prev2, diff, diff2 }
}

// 出力の並び: テナントの階（空欄が先）→ 請求先コード → メータの階 → テナント内連番 → メータ番号。
// テナントに属さないメータは最後
function compareMeters(a, b) {
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
 * @param {object} p
 * @param {string} p.month 検針月度 'YYYY-MM'
 * @param {object[]} p.tenants equipment_tenants の行（id, billing_code, name, short_name, floor, moved_out, moved_in_on）
 * @param {object[]} p.meters meters の行（tenant_id で tenants を引く）
 * @param {object[]} p.readings その月度と前月度の検針値（meter_id, month, …）
 * @param {object[]} p.acUsage その月度の空調データ（meter_no, day_wh）
 * @param {number} p.oaCoefficient 外調データ係数（定数。既定40）
 * @returns {{ columns: string[], rows: any[][] }}
 */
export function buildMeterOutput({ month, tenants, meters, readings, acUsage, oaCoefficient = 40 }) {
  const prevMonth = shiftMonth(month, -1)
  const tenantById = new Map(tenants.map((t) => [t.id, t]))
  const current = new Map()
  const previous = new Map()
  for (const r of readings) {
    if (r.month === month) current.set(r.meter_id, r)
    else if (r.month === prevMonth) previous.set(r.meter_id, r)
  }

  // 空調: 割当てメータごとの昼間電力の合計と台数（取り込んだ時点の割当てで集計）
  const acByMeter = new Map()
  for (const u of acUsage) {
    if (!u.meter_no) continue
    const acc = acByMeter.get(u.meter_no) || { wh: 0, count: 0 }
    acc.wh += u.day_wh || 0
    acc.count += 1
    acByMeter.set(u.meter_no, acc)
  }

  // 外調機の当月の電力量（外調機メータの差分＋差分_2）
  const oaMeter = meters.find((m) => m.is_oa_meter && !m.removed)
  let oaTotal = 0
  if (oaMeter && current.has(oaMeter.id)) {
    const u = readingUsage(current.get(oaMeter.id), previous.get(oaMeter.id), oaMeter)
    oaTotal = tidy(u.diff + u.diff2)
  }

  const items = meters
    .filter((m) => !m.removed)
    .map((meter) => ({ meter, tenant: meter.tenant_id ? tenantById.get(meter.tenant_id) || null : null }))
    .sort(compareMeters)

  // 1行ずつ組み立てる（合算の2列は後で埋める）
  const built = items.map(({ meter, tenant }) => {
    const reading = current.get(meter.id) || null
    const prevReading = previous.get(meter.id) || null
    const usage = reading ? readingUsage(reading, prevReading, meter) : null
    const code = tenant?.billing_code || null

    const ac = acByMeter.get(meter.meter_no)
    const acTotal = ac ? ac.wh : null
    const acBilling = ac ? Math.floor(ac.wh / 1000) : null

    // 外調機: その月の検針値があるメータだけ当月値を持つ（無ければ空欄）。
    // 按分量は「当月値も比率も空」なら空欄、請求用は係数が常にあるので常に数値
    const oaMonth = reading ? oaTotal : null
    const oaRatio = meter.oa_ratio ?? null
    const oaShare = oaMonth == null && oaRatio == null ? null : tidy((oaMonth || 0) * (oaRatio || 0))
    const oaBilling = Math.round((oaMonth || 0) * oaCoefficient * (oaRatio || 0))
    const acOaTotal = oaBilling + (acBilling || 0)

    const readOn = reading?.read_on || null
    const periodMonth = readOn ? shiftMonth(readOn.slice(0, 7), -1) : null

    return {
      code,
      kind: meter.kind,
      hasReading: !!reading,
      diff: usage ? usage.diff : 0,
      acOaTotal,
      cells: [
        tenant?.floor || null,
        code && meter.seq != null ? `${code}_${meter.seq}` : null,
        meter.meter_no,
        meter.room_no || null,
        `${meter.room_name || ''} ${meter.detail_note || ''}`,
        reading?.value ?? null,
        reading?.value2 ?? null,
        usage ? usage.prev : 0,
        usage ? usage.prev2 : 0,
        usage ? usage.diff : 0,
        usage ? usage.diff2 : 0,
        acOaTotal,
        reading ? fmMonthLabel(month) : null,
        reading ? fmMonthLabel(prevMonth) : null,
        periodMonth ? dateCell(`${periodMonth}-01`) : null,
        periodMonth ? dateCell(`${periodMonth}-${String(lastDayOf(periodMonth)).padStart(2, '0')}`) : null,
        reading ? dateCell(`${month}-01`) : null,
        dateCell(readOn),
        reading ? dateCell(prevReading?.read_on || null) : null,
        code,
        tenant?.name || null,
        tenant?.short_name || null,
        tenant?.moved_out ? 1 : null,
        meter.seq ?? null,
        meter.floor || null,
        meter.room_name || null,
        meter.detail_note || null,
        meter.area_m2 ?? null,
        meter.area_tsubo ?? null,
        meter.kind || null,
        meter.seal_label || null,
        meter.measured ? 1 : null,
        meter.oa_share ? 1 : 0,
        meter.digits ?? null,
        meter.removed ? 1 : null,
        acTotal,
        acBilling,
        ac ? ac.count : null,
        oaMonth,
        oaRatio,
        oaShare,
        oaBilling,
        tenant?.moved_in_on ? fmMonthLabel(tenant.moved_in_on.slice(0, 7)) : null,
        null, // 請求先合算_メーター値（下で埋める）
        null, // 請求先合算_空調外調_合計（下で埋める）
        reading ? timeCell(reading.read_time) : null,
        oaCoefficient,
      ],
    }
  })

  // 請求先合算: 請求先コード×検針内容（電気・ガス・水道）ごと。
  // メーター値はその月の検針値があるメータの差分の合計（1件も無ければ空欄）、
  // 空調外調はグループ内の全メータの合計。コードか検針内容が空のメータは空欄
  const groups = new Map()
  for (const b of built) {
    if (!b.code || !b.kind) continue
    const key = `${b.code}\u0000${b.kind}`
    const g = groups.get(key) || { diff: 0, readCount: 0, acOa: 0 }
    if (b.hasReading) {
      g.diff = tidy(g.diff + b.diff)
      g.readCount += 1
    }
    g.acOa += b.acOaTotal
    groups.set(key, g)
  }
  for (const b of built) {
    if (!b.code || !b.kind) continue
    const g = groups.get(`${b.code}\u0000${b.kind}`)
    b.cells[43] = g.readCount > 0 ? g.diff : null
    b.cells[44] = g.acOa
  }

  return { columns: METER_OUTPUT_COLUMNS, rows: built.map((b) => b.cells) }
}

// ---------- FileMaker が出した xlsx との突き合わせ（並行運用の確認用） ----------

// 日付・時刻のセルを Excel の通し番号にする（日付は 1899-12-30 からの日数、時刻は1日に対する割合）
export function excelSerial(cell) {
  if (!cell || typeof cell !== 'object') return cell
  if (cell.type === 'date') {
    const [y, m, d] = cell.value.split('-').map(Number)
    return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000
  }
  if (cell.type === 'time') {
    const [h, mi, s] = cell.value.split(':').map(Number)
    return (h * 3600 + mi * 60 + s) / 86400
  }
  return null
}

/**
 * 組み立てた出力と、xlsx の先頭シート（xlsxRead.js の readFirstSheetRows の結果）を全セル比べる。
 * @returns {{ cells: number, problems: { row: number, col: number, column: string, meterNo: string, expected: any, actual: any }[] }}
 */
export function compareMeterOutput(output, sheetRows) {
  const [head = [], ...rows] = sheetRows
  const problems = []
  METER_OUTPUT_COLUMNS.forEach((name, c) => {
    if ((head[c] ?? null) !== name) {
      problems.push({ row: 1, col: c + 1, column: name, meterNo: '', expected: head[c] ?? null, actual: name })
    }
  })
  const same = (a, b) => {
    if (a == null || a === '' || b == null || b === '') return (a == null || a === '') && (b == null || b === '')
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6
    return a === b
  }
  let cells = 0
  const n = Math.max(rows.length, output.rows.length)
  for (let i = 0; i < n; i++) {
    const e = rows[i] || []
    const o = output.rows[i] || []
    for (let c = 0; c < METER_OUTPUT_COLUMNS.length; c++) {
      cells++
      const actual = excelSerial(o[c] ?? null)
      const expected = e[c] ?? null
      if (!same(expected, actual)) {
        problems.push({
          row: i + 2,
          col: c + 1,
          column: METER_OUTPUT_COLUMNS[c],
          meterNo: String(o[2] ?? e[2] ?? ''),
          expected,
          actual,
        })
      }
    }
  }
  return { cells, problems }
}
