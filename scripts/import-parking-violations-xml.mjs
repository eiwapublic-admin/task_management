#!/usr/bin/env node
// 不正駐車：FileMaker（koizumi-report.fmp12）からのFMPXMLRESULT移行スクリプト。ローカル実行専用。
// 2026-08-25依頼。全件移行（日付の範囲指定なし）。
//
// 使い方:
//   node scripts/import-parking-violations-xml.mjs <XMLパス> [--dry-run] [--emit-sql=<dir>]
//
// 移行方針:
//   - parking_violations.report_id は daily_reports(id) への NOT NULL 外部キーのため、
//     「日付」に対応する daily_reports.report_date が既に存在することが前提（違反車両は
//     必ずその日の日報に紐づく設計）。生成したSQLは INSERT ... SELECT ... JOIN daily_reports
//     で当日のreport_idを引く形にする（日報側の移行が先に完了している前提）
//   - 「違反事項」は改行区切りの複数値。アプリのVALID_VIOLATIONS（unrecorded/false_entry/
//     long_stay/after_hours/other）へラベルで対応させる。FileMaker側の「虚偽記載」は
//     アプリ側ラベル「虚偽記入」と字面が異なるが同じ概念のため false_entry に対応させる
//   - プレートナンバーはアプリの sanitizePlateNumber と同じ規則（数字のみ残し先頭4桁）で正規化
//   - 日付・時刻ともに空の行（付随情報も全て空）は空レコードとみなし移行対象から除外する。
//     チェック時刻のみ空の行は checked_at を 00:00:00（時刻不明の意）として移行する

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

// 'H:MM:SS' 等 -> 'HH:MM:SS'。不正・空なら null
function toTime(t) {
  const m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec((t || '').trim())
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  const ss = m[3] ? Number(m[3]) : 0
  if (hh > 23 || mm > 59 || ss > 59) return null
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

// アプリ側 sanitizePlateNumber（worker/lib/reports.js）と同じ規則
function sanitizePlateNumber(value) {
  const digits = (value || '').replace(/\D/g, '').slice(0, 4)
  return digits || null
}

const VIOLATION_LABEL_TO_CODE = {
  未記録: 'unrecorded',
  虚偽記載: 'false_entry', // アプリのラベル「虚偽記入」とは字面が異なるが同義として対応
  長時間駐車: 'long_stay',
  時間外駐車: 'after_hours',
  その他: 'other',
}

function parseViolations(raw) {
  const codes = new Set()
  // FileMakerの改行区切りは環境により \r のみ・\r\n・\n が混在するため全て対応する
  for (const line of (raw || '').split(/\r\n|\r|\n/)) {
    const label = line.trim()
    if (!label) continue
    const code = VIOLATION_LABEL_TO_CODE[label]
    if (code) codes.add(code)
    else console.warn(`未知の違反事項ラベル（無視）: ${JSON.stringify(label)}`)
  }
  return [...codes]
}

function trimOrNull(v) {
  const t = (v || '').trim()
  return t || null
}

function sqlLit(v) {
  return v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`
}

function sqlTextArrayLit(arr) {
  if (!arr || arr.length === 0) return "'{}'::text[]"
  return `ARRAY[${arr.map((v) => sqlLit(v)).join(', ')}]::text[]`
}

function buildRecords(rows) {
  const records = []
  let blankSkipped = 0
  for (const r of rows) {
    const isoDate = toIsoDate(single(r, '日付'))
    if (!isoDate) continue

    const plateRegion = trimOrNull(single(r, 'プレート地域'))
    const plateNumber = sanitizePlateNumber(single(r, 'プレートナンバー'))
    const maker = trimOrNull(single(r, '車メーカー'))
    const model = trimOrNull(single(r, '車種'))
    const ownerCompany = trimOrNull(single(r, '所有会社・訪問先'))
    const violations = parseViolations(single(r, '違反事項'))
    const note = trimOrNull(single(r, '補足'))

    // 日付以外が全て空 = FileMaker側の空レコード。移行対象から除外する
    if (!plateRegion && !plateNumber && !maker && !model && !ownerCompany && violations.length === 0 && !note) {
      blankSkipped++
      continue
    }

    const time = toTime(single(r, 'チェック時刻')) || '00:00:00'
    const checkedAt = `${isoDate}T${time}+09:00`

    records.push({
      report_date: isoDate,
      checked_at: checkedAt,
      plate_region: plateRegion,
      plate_number: plateNumber,
      maker,
      model,
      owner_company: ownerCompany,
      violations,
      note,
    })
  }
  return { records, blankSkipped }
}

function emitSqlFile(dir, records) {
  mkdirSync(dir, { recursive: true })
  const valuesLines = records.map(
    (r) =>
      `  (${sqlLit(r.report_date)}, ${sqlLit(r.checked_at)}, ${sqlLit(r.plate_region)}, ${sqlLit(r.plate_number)}, ${sqlLit(r.maker)}, ${sqlLit(r.model)}, ${sqlLit(r.owner_company)}, ${sqlTextArrayLit(r.violations)}, ${sqlLit(r.note)})`
  )
  const sql = `-- 不正駐車移行: 全期間（${records.length}件）
INSERT INTO parking_violations (report_id, checked_at, plate_region, plate_number, maker, model, owner_company, violations, note)
SELECT dr.id, v.checked_at::timestamptz, v.plate_region, v.plate_number, v.maker, v.model, v.owner_company, v.violations, v.note
FROM (VALUES
${valuesLines.join(',\n')}
) AS v(report_date, checked_at, plate_region, plate_number, maker, model, owner_company, violations, note)
JOIN daily_reports dr ON dr.report_date = v.report_date::date;
`
  const path = `${dir}/parking_violations.sql`
  writeFileSync(path, sql)
  console.log(`書き出し: ${path}（${records.length}件）`)
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const xmlPath = args.find((a) => !a.startsWith('--'))
  if (!xmlPath) {
    console.error('使い方: node scripts/import-parking-violations-xml.mjs <XMLパス> [--dry-run] [--emit-sql=<dir>]')
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

  const { records, blankSkipped } = buildRecords(rows)
  console.log(`移行対象: ${records.length}件（空レコードとして除外: ${blankSkipped}件）`)

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
    checked_at: r.checked_at,
    plate_region: r.plate_region,
    plate_number: r.plate_number,
    maker: r.maker,
    model: r.model,
    owner_company: r.owner_company,
    violations: r.violations,
    note: r.note,
  }))

  const CHUNK = 200
  for (let i = 0; i < rowsToInsert.length; i += CHUNK) {
    const chunk = rowsToInsert.slice(i, i + CHUNK)
    const { error } = await supabase.from('parking_violations').insert(chunk)
    if (error) throw error
    console.log(`insert ${Math.min(i + CHUNK, rowsToInsert.length)}/${rowsToInsert.length}`)
  }
  console.log('完了')
}

main().catch((err) => {
  console.error('失敗:', err)
  process.exit(1)
})
