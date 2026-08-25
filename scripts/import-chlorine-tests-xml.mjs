#!/usr/bin/env node
// 残留塩素濃度検査：FileMaker（BKB-Mgt.fmp12）からのFMPXMLRESULT移行スクリプト。ローカル実行専用。
// 2026-08-25依頼。全件移行（日付の範囲指定なし）。
//
// 使い方:
//   node scripts/import-chlorine-tests-xml.mjs <XMLパス> [--dry-run] [--emit-sql=<dir>]
//
// 移行方針:
//   - chlorine_tests.report_id は daily_reports(id) への NOT NULL 外部キーのため、
//     「測定日」に対応する daily_reports.report_date が既に存在することが前提。生成したSQLは
//     INSERT ... SELECT ... JOIN daily_reports で当日のreport_idを引く形にする
//   - 測定施設名は「BKB」「小泉本社」に加えて「スイングビル」も含まれる（2026-08-10時点では
//     2施設のみとして対象外にしていたが、直近まで継続して測定記録があったため今回3施設目
//     として追加した。src/lib/reports.js の CHLORINE_BUILDINGS・worker/lib/reports.js の
//     VALID_CHLORINE_BUILDINGS を参照）
//   - 色・濁り・臭気・味は "OK" / "" の2値のみ（全520件確認済み、"NG"は無し）。
//     "OK"→true、空→null（未選択）としてDBのboolean列にマッピングする
//   - 作成/修正のタイムスタンプ・アカウントは移行対象外（他の移行スクリプトと同じ方針。
//     created_at/updated_atはDB既定値、created_byは対応するuserが一意に定まらないため空のまま）

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function parseFmpXml(text) {
  const fieldNames = [...text.matchAll(/<FIELD\b[^>]*\bNAME="([^"]*)"[^>]*\/>/g)].map((m) => decodeEntities(m[1]))
  const rows = []
  const rowRe = /<ROW\b[^>]*RECORDID="([^"]*)"[^>]*>([\s\S]*?)<\/ROW>/g
  let rowMatch
  while ((rowMatch = rowRe.exec(text))) {
    const recordId = rowMatch[1]
    const rowBody = rowMatch[2]
    const cols = [...rowBody.matchAll(/<COL>([\s\S]*?)<\/COL>/g)].map((colMatch) =>
      [...colMatch[1].matchAll(/<DATA>([\s\S]*?)<\/DATA>/g)].map((d) => decodeEntities(d[1]))
    )
    const rec = { _recordId: recordId }
    fieldNames.forEach((name, i) => {
      rec[name] = cols[i] || []
    })
    rows.push(rec)
  }
  return { fieldNames, rows }
}

function single(rec, name) {
  const v = rec[name]
  return v && v.length ? v[0] : ''
}

function toIsoDate(d) {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((d || '').trim())
  if (!m) return null
  const [, y, mo, day] = m
  return `${y}-${mo.padStart(2, '0')}-${day.padStart(2, '0')}`
}

// '2026/08/18 13:49:06' -> '2026-08-18T13:49:06+09:00'（JST固定。FileMaker側はJST運用のため）。
// 秒が省略された表記（'2026/04/28 12:50'）も152件あったため秒は任意（省略時は00）とする
function toIsoTimestamp(dt) {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec((dt || '').trim())
  if (!m) return null
  const [, y, mo, day, hh, mi, ss] = m
  return `${y}-${mo.padStart(2, '0')}-${day.padStart(2, '0')}T${hh.padStart(2, '0')}:${mi.padStart(2, '0')}:${(ss || '0').padStart(2, '0')}+09:00`
}

function trimOrNull(v) {
  const t = (v || '').trim()
  return t || null
}

// 'OK' -> true / '' -> null（'NG'は本データセットに存在しないため未対応。混入していたら警告する）
function toJudgement(v, fieldLabel) {
  const t = (v || '').trim()
  if (!t) return null
  if (t === 'OK') return true
  if (t === 'NG') return false
  console.warn(`未知の${fieldLabel}判定（NULL扱い）: ${JSON.stringify(t)}`)
  return null
}

function toConcentration(v) {
  const t = (v || '').trim()
  if (!t) return null
  const num = Number(t)
  return Number.isFinite(num) ? num : null
}

function buildRecords(rows) {
  const records = []
  let skipped = 0
  for (const r of rows) {
    const isoDate = toIsoDate(single(r, '測定日'))
    const testedAt = toIsoTimestamp(single(r, '測定日時'))
    const building = trimOrNull(single(r, '測定施設名'))
    if (!isoDate || !testedAt || !building) {
      skipped++
      continue
    }
    records.push({
      report_date: isoDate,
      tested_at: testedAt,
      building,
      location: trimOrNull(single(r, '測定場所')),
      inspector: trimOrNull(single(r, '検査者')),
      concentration: toConcentration(single(r, '残留塩素濃度')),
      color_ok: toJudgement(single(r, '色'), '色'),
      turbidity_ok: toJudgement(single(r, '濁り'), '濁り'),
      odor_ok: toJudgement(single(r, '臭気'), '臭気'),
      taste_ok: toJudgement(single(r, '味'), '味'),
      note: trimOrNull(single(r, '備考')),
    })
  }
  return { records, skipped }
}

function sqlLit(v) {
  return v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`
}

function sqlNumLit(v) {
  return v == null ? 'NULL' : String(v)
}

function sqlBoolLit(v) {
  return v == null ? 'NULL' : v ? 'TRUE' : 'FALSE'
}

function toValuesLine(r) {
  return `  (${sqlLit(r.report_date)}, ${sqlLit(r.tested_at)}, ${sqlLit(r.building)}, ${sqlLit(r.location)}, ${sqlLit(r.inspector)}, ${sqlNumLit(r.concentration)}, ${sqlBoolLit(r.color_ok)}, ${sqlBoolLit(r.turbidity_ok)}, ${sqlBoolLit(r.odor_ok)}, ${sqlBoolLit(r.taste_ok)}, ${sqlLit(r.note)})`
}

function wrapInsertSql(label, valuesLines) {
  return `-- 残留塩素濃度検査移行: ${label}（${valuesLines.length}件）
INSERT INTO chlorine_tests (report_id, tested_at, building, location, inspector, concentration, color_ok, turbidity_ok, odor_ok, taste_ok, note)
SELECT dr.id, v.tested_at::timestamptz, v.building, v.location, v.inspector, v.concentration, v.color_ok, v.turbidity_ok, v.odor_ok, v.taste_ok, v.note
FROM (VALUES
${valuesLines.join(',\n')}
) AS v(report_date, tested_at, building, location, inspector, concentration, color_ok, turbidity_ok, odor_ok, taste_ok, note)
JOIN daily_reports dr ON dr.report_date = v.report_date::date;
`
}

// 1ファイルだと大きすぎてexecute_sql等で扱いにくいため、日報移行スクリプトと同様に
// 年ごとのファイルへ分割する（--emit-sql=<dir>で使用）
function emitSqlFile(dir, records) {
  mkdirSync(dir, { recursive: true })
  const byYear = new Map()
  for (const r of records) {
    const year = r.report_date.slice(0, 4)
    if (!byYear.has(year)) byYear.set(year, [])
    byYear.get(year).push(r)
  }
  for (const [year, yearRecords] of [...byYear.entries()].sort()) {
    const sql = wrapInsertSql(`${year}年分`, yearRecords.map(toValuesLine))
    const path = `${dir}/chlorine_tests_${year}.sql`
    writeFileSync(path, sql)
    console.log(`書き出し: ${path}（${yearRecords.length}件）`)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const xmlPath = args.find((a) => !a.startsWith('--'))
  if (!xmlPath) {
    console.error('使い方: node scripts/import-chlorine-tests-xml.mjs <XMLパス> [--dry-run] [--emit-sql=<dir>]')
    process.exit(1)
  }

  let supabase = null
  if (!dryRun && !args.some((a) => a.startsWith('--emit-sql='))) {
    const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      console.error('環境変数 SUPABASE_URL / SUPABASE_SERVICE_KEY が必要です')
      process.exit(1)
    }
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }

  const text = readFileSync(xmlPath, 'utf-8')
  const { rows } = parseFmpXml(text)
  console.log(`XML読込: ${rows.length}件`)

  const { records, skipped } = buildRecords(rows)
  console.log(`移行対象: ${records.length}件（日付・時刻・施設名のいずれかが空のため除外: ${skipped}件）`)

  const buildingCounts = {}
  for (const r of records) buildingCounts[r.building] = (buildingCounts[r.building] || 0) + 1
  console.log('施設別件数:', buildingCounts)

  const emitSqlArg = args.find((a) => a.startsWith('--emit-sql='))
  if (emitSqlArg) {
    emitSqlFile(emitSqlArg.slice('--emit-sql='.length), records)
    return
  }

  if (dryRun) {
    console.log('--dry-run のため書き込みは行いません。サンプル（先頭5件）:')
    console.log(JSON.stringify(records.slice(0, 5), null, 2))
    return
  }

  // 安全対策: report_date が daily_reports に存在しない行が無いことを確認してから実行する
  const dates = [...new Set(records.map((r) => r.report_date))]
  const { data: existingReports, error: reportsErr } = await supabase.from('daily_reports').select('id, report_date').in('report_date', dates)
  if (reportsErr) throw reportsErr
  const reportIdByDate = new Map(existingReports.map((r) => [r.report_date, r.id]))
  const missing = dates.filter((d) => !reportIdByDate.has(d))
  if (missing.length) {
    console.error(`日報が存在しない日付があるため中止します（${missing.length}件）:`, missing.slice(0, 20))
    process.exit(1)
  }

  const rowsToInsert = records.map((r) => ({
    report_id: reportIdByDate.get(r.report_date),
    tested_at: r.tested_at,
    building: r.building,
    location: r.location,
    inspector: r.inspector,
    concentration: r.concentration,
    color_ok: r.color_ok,
    turbidity_ok: r.turbidity_ok,
    odor_ok: r.odor_ok,
    taste_ok: r.taste_ok,
    note: r.note,
  }))

  const CHUNK = 200
  for (let i = 0; i < rowsToInsert.length; i += CHUNK) {
    const chunk = rowsToInsert.slice(i, i + CHUNK)
    const { error } = await supabase.from('chlorine_tests').insert(chunk)
    if (error) throw error
    console.log(`insert ${Math.min(i + CHUNK, rowsToInsert.length)}/${rowsToInsert.length}`)
  }
  console.log('完了')
}

main().catch((err) => {
  console.error('失敗:', err)
  process.exit(1)
})
