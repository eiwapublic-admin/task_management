#!/usr/bin/env node
// 日報：FileMaker（koizumi-report.fmp12）からのFMPXMLRESULT移行スクリプト。ローカル実行専用。
// 2026-08-24依頼。2026年7月末まで（8月分はシステムへ並行入力中のため対象外）を移行する。
//
// 使い方:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/import-daily-reports-xml.mjs <XMLパス> [--dry-run] [--until=2026-07-31]
//
// 取込方針:
//   - report_date は「日付」フィールドを採用する（「開始日」「終了日」と食い違う記録が85件あるが、
//     日報を検索・表示する単位はこの「日付」のため）
//   - 担当者（worker_am/worker_pm）は「作業者」（自由記述の結合欄。例:「午前：岡田 午後：西川」）を
//     解析して採用する。discrete な「作業者AM」「作業者PM」欄より実際は網羅的（野山・大平・藤崎等、
//     discrete 欄には一切現れない担当者名がこちらにしか無い）ため。解析できない場合のみ
//     discrete 欄にフォールバックする
//   - 「件名」「報告者」「分類」「作業内容」「備考」は現行スキーマに対応する列が無いため移行しない
//     （件名はほぼ「日常報告書」の定型文、分類は全件"01"で無意味、報告者はFileMaker当時のPC
//     ログイン名で現在のusersと対応しない、備考は3583件中10件のみ・内容も「無し」等でほぼ無意味）
//   - report_date の UNIQUE制約に対応するため、同一日付の記録が複数ある場合（53組）は1件に統合する。
//     entries の多い方（＝より詳細な記録）を優先レコードとし、担当者・開始/終了時刻はそちらを採用。
//     entries は両方の記録から重複しない内容を集めて時刻順にまとめる
//   - 特記事項入力用（最大10件の繰り返し）は report_entries へ1件ずつ展開する（時刻が無い場合はNULL）

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

// ---- FMPXMLRESULTの最小限パーサ（ROW/COL/DATAの単純な構造のみを前提とする） ----
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function parseFmpXml(text) {
  const fieldNames = [...text.matchAll(/<FIELD\b[^>]*\bNAME="([^"]*)"[^>]*\/>/g)].map((m) =>
    decodeEntities(m[1])
  )
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

// 'YYYY/MM/DD' → 'YYYY-MM-DD'
function toIsoDate(d) {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(d.trim())
  if (!m) return null
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
}

// 'H:MM' 等 → 'HH:MM:00'（不正・空はnull）
function toTime(t) {
  const s = (t || '').trim()
  if (!s) return null
  const m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(s)
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  const ss = Number(m[3] || 0)
  if (hh > 23 || mm > 59 || ss > 59) return null
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

// 「作業者」結合欄（例:「午前：岡田 午後：西川」「午前：橋口 午後： -」）を解析する。
// 表記ゆれ（コロン全角/半角/無し・全角セミコロン・全角スペース・「-」＝空欄印）に対応する。
// 解析できなければ null を返し、呼び出し側で discrete 欄へフォールバックする
function parseCombinedWorkers(combo) {
  const s = (combo || '').trim()
  if (!s) return null
  const m = /^午前\s*[:：]?\s*(.*?)\s*午後\s*[:：；]?\s*(.*?)$/.exec(s)
  if (!m) return null
  const clean = (v) => {
    let t = (v || '').replace(/[\s　]+/g, '').replace(/^[:：；]+|[:：；]+$/g, '')
    if (t === '-' || t === '－' || t === 'ー') t = ''
    return t
  }
  return { am: clean(m[1]), pm: clean(m[2]) }
}

function resolveWorkers(rec) {
  const parsed = parseCombinedWorkers(single(rec, '作業者'))
  if (parsed) return { workers: parsed, fromCombo: true }
  return { workers: { am: single(rec, '作業者AM').trim(), pm: single(rec, '作業者PM').trim() }, fromCombo: false }
}

// 「作業内容」欄の定型文（現行の意味の無いカテゴリラベル）。2014〜2015頃の初期の記録では
// 「特記事項入力用」欄が使われておらず、代わりにこの欄へ実際の作業内容が書かれていることが
// あるため、定型文以外の値は救済して report_entries へ1件だけ追加する（下記 extractEntries 参照）
const WORK_CONTENT_BOILERPLATE = new Set([
  '通常業務', '定期清掃業務', '定期業務', '定期点検業務', 'コイズミ本社ビル定期清掃業務',
  '備後町コイズミビル定期清掃業務', '定期設備点検業務', '定期日常業務', '通常道理', '特別清掃業務',
  '日常業務', '業務', '',
])

// 特記事項入力用（繰り返し）→ { time: 'HH:MM:00'|null, content: string }[]（空欄は除外）。
// 繰り返し欄が1件も無い場合だけ、「作業内容」欄が定型文以外なら実質的な記録として1件補う
// （2014〜2015頃の初期データ救済。開始時間があればそれを時刻として使う）
function extractEntries(rec) {
  const contents = rec['特記事項入力用'] || []
  const times = rec['特記事項入力用時刻'] || []
  const out = []
  const max = Math.max(contents.length, times.length)
  for (let i = 0; i < max; i++) {
    const content = (contents[i] || '').trim()
    if (!content) continue
    out.push({ time: toTime(times[i] || ''), content })
  }
  if (out.length === 0) {
    const workContent = single(rec, '作業内容').trim()
    if (workContent && !WORK_CONTENT_BOILERPLATE.has(workContent)) {
      out.push({ time: toTime(single(rec, '開始時間')), content: workContent })
    }
  }
  return out
}

// 同一 report_date の複数FileMakerレコードを1件に統合する。
// entries数の多い方を「主レコード」とし、担当者・開始/終了時刻はそちらを採用。
// entries は両方から集め、内容（前後空白除去）が完全一致するものは重複除去したうえで
// 時刻順（時刻無しは末尾・元の順序を保つ安定ソート）に並べる
function mergeSameDateRecords(records) {
  if (records.length === 1) return records[0]
  const withEntries = records.map((r) => ({ rec: r, entries: extractEntries(r) }))
  withEntries.sort((a, b) => b.entries.length - a.entries.length || Number(b.rec._recordId) - Number(a.rec._recordId))
  const primary = withEntries[0].rec
  const seen = new Set()
  const mergedEntries = []
  for (const { entries } of withEntries) {
    for (const e of entries) {
      const key = e.content
      if (seen.has(key)) continue
      seen.add(key)
      mergedEntries.push(e)
    }
  }
  return { _merged: true, _primary: primary, _entries: mergedEntries, _sourceIds: records.map((r) => r._recordId) }
}

function sqlLit(v) {
  if (v === null || v === undefined) return 'NULL'
  return `'${String(v).replace(/'/g, "''")}'`
}

// SUPABASE_SERVICE_KEY を用意できない実行環境向けに、supabase-js を介さず直接SQLとして
// 流し込めるファイルを年ごとに書き出す（Supabase MCP の execute_sql 等で実行する想定）。
// daily_reports への INSERT ... RETURNING を report_entries への INSERT のソースとして
// 1つの文にまとめることで、IDの手動採番・突合を不要にしている
function emitSqlFiles(dir, dailyReports, entriesByDate) {
  mkdirSync(dir, { recursive: true })
  const byYear = new Map()
  for (const dr of dailyReports) {
    const year = dr.report_date.slice(0, 4)
    if (!byYear.has(year)) byYear.set(year, [])
    byYear.get(year).push(dr)
  }
  for (const [year, reports] of [...byYear.entries()].sort()) {
    const reportValues = reports
      .map(
        (r) =>
          `(${sqlLit(r.report_date)}, ${sqlLit(r.worker_am)}, ${sqlLit(r.worker_pm)}, ${sqlLit(r.work_start)}, ${sqlLit(r.work_end)})`
      )
      .join(',\n  ')
    const entryValues = []
    for (const r of reports) {
      const entries = entriesByDate.get(r.report_date) || []
      entries.forEach((e, sortOrder) => {
        entryValues.push(`(${sqlLit(r.report_date)}, ${sqlLit(e.time)}, ${sqlLit(e.content)}, ${sortOrder})`)
      })
    }
    const entryValuesSql = entryValues.length
      ? entryValues.join(',\n  ')
      : "('1970-01-01', NULL, '', 0)" // ダミー1行（下のWHEREで除外。VALUES句を空にできないため）
    // src_entries.report_date はリテラルだけだと text 型に推論されるため、JOIN/WHERE 側で
    // 明示的に ::date へキャストする（VALUES内の一部の行だけ ::date を付けても列全体の型には
    // 反映されないため、キャストは呼び出し側で行う必要がある）
    const sql = `-- 日報移行: ${year}年（${reports.length}日分 / entries ${entryValues.length}件）
WITH inserted AS (
  INSERT INTO daily_reports (report_date, worker_am, worker_pm, work_start, work_end)
  VALUES
  ${reportValues}
  RETURNING id, report_date
),
src_entries (report_date, entry_time, content, sort_order) AS (
  VALUES
  ${entryValuesSql}
)
INSERT INTO report_entries (report_id, entry_time, content, sort_order)
SELECT i.id, e.entry_time::time, e.content, e.sort_order::int
FROM src_entries e
JOIN inserted i ON i.report_date = e.report_date::date
WHERE e.report_date::date <> '1970-01-01'::date;
`
    const path = `${dir}/${year}.sql`
    writeFileSync(path, sql, 'utf-8')
    console.log(`書き出し: ${path}（${reports.length}日 / entries ${entryValues.length}件）`)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const untilArg = args.find((a) => a.startsWith('--until='))
  const until = untilArg ? untilArg.slice('--until='.length) : '2026-07-31'
  const xmlPath = args.find((a) => !a.startsWith('--'))
  if (!xmlPath) {
    console.error(
      '使い方: node scripts/import-daily-reports-xml.mjs <XMLパス> [--dry-run] [--emit-sql=<dir>] [--until=YYYY-MM-DD]'
    )
    process.exit(1)
  }

  // --dry-run / --emit-sql はXMLの解析結果だけを扱い、DBへは一切アクセスしないため、
  // 認証情報が無くても実行できるようにする（supabase-jsで直接書き込む本番反映時のみ必須。
  // SUPABASE_SERVICE_KEYを用意できない環境では --emit-sql で書き出したSQLを
  // 別途（例: Supabase MCPのexecute_sql等）実行すればよい）
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

  // report_date でグルーピングし、until 以前だけを対象にする
  const byDate = new Map()
  for (const r of rows) {
    const isoDate = toIsoDate(single(r, '日付'))
    if (!isoDate || isoDate > until) continue
    if (!byDate.has(isoDate)) byDate.set(isoDate, [])
    byDate.get(isoDate).push(r)
  }
  console.log(`対象日数（${until}まで）: ${byDate.size}日 / 元レコード ${[...byDate.values()].reduce((s, l) => s + l.length, 0)}件`)

  const comboFallbackDates = []
  const dailyReports = []
  const entriesByDate = new Map()

  for (const [isoDate, records] of byDate) {
    const merged = records.length > 1 ? mergeSameDateRecords(records) : records[0]
    const primaryRec = merged._merged ? merged._primary : merged
    const entries = merged._merged ? merged._entries : extractEntries(primaryRec)

    const { workers, fromCombo } = resolveWorkers(primaryRec)
    if (!fromCombo) comboFallbackDates.push(isoDate)

    dailyReports.push({
      report_date: isoDate,
      worker_am: workers.am || null,
      worker_pm: workers.pm || null,
      work_start: toTime(single(primaryRec, '開始時間')),
      work_end: toTime(single(primaryRec, '終了時間')),
    })

    // 時刻順（時刻無しは末尾）。安定ソートを保証するため元のindexを添えて比較する
    const sorted = entries
      .map((e, idx) => ({ ...e, idx }))
      .sort((a, b) => {
        if (a.time && b.time) return a.time < b.time ? -1 : a.time > b.time ? 1 : a.idx - b.idx
        if (a.time && !b.time) return -1
        if (!a.time && b.time) return 1
        return a.idx - b.idx
      })
    entriesByDate.set(isoDate, sorted)
  }

  console.log(`統合後の日報件数: ${dailyReports.length}件`)
  console.log(`「作業者」結合欄が解析できず discrete 欄へフォールバックした日数: ${comboFallbackDates.length}件`)
  const totalEntries = [...entriesByDate.values()].reduce((s, l) => s + l.length, 0)
  console.log(`report_entries 合計: ${totalEntries}件`)

  const emitSqlArg = args.find((a) => a.startsWith('--emit-sql='))
  if (emitSqlArg) {
    emitSqlFiles(emitSqlArg.slice('--emit-sql='.length), dailyReports, entriesByDate)
    return
  }

  if (dryRun) {
    console.log('--dry-run のためDBへは書き込みません。サンプル（先頭3日分）:')
    const sampleArg = args.find((a) => a.startsWith('--sample='))
    const sampleDates = sampleArg ? sampleArg.slice('--sample='.length).split(',') : [...byDate.keys()].sort().slice(0, 3)
    for (const d of sampleDates) {
      const dr = dailyReports.find((r) => r.report_date === d)
      console.log(JSON.stringify(dr))
      console.log('  entries:', JSON.stringify(entriesByDate.get(d)))
    }
    if (comboFallbackDates.length) {
      console.log('フォールバック日の例（先頭10件）:', comboFallbackDates.slice(0, 10))
    }
    return
  }

  // 安全対策: 移行範囲内に既存の daily_reports が無いことを確認してから実行する
  // （二重実行や本番の並行入力データとの衝突を避けるため）
  const { data: existing, error: existingErr } = await supabase
    .from('daily_reports')
    .select('report_date')
    .lte('report_date', until)
  if (existingErr) throw existingErr
  if (existing.length > 0) {
    console.error(
      `移行対象期間（〜${until}）に既存の daily_reports が ${existing.length}件あります。二重実行の可能性があるため中止します。`
    )
    console.error('既存分:', existing.map((r) => r.report_date).slice(0, 20))
    process.exit(1)
  }

  const CHUNK = 200
  const reportIdByDate = new Map()
  for (let i = 0; i < dailyReports.length; i += CHUNK) {
    const chunk = dailyReports.slice(i, i + CHUNK)
    const { data, error } = await supabase.from('daily_reports').insert(chunk).select('id, report_date')
    if (error) throw error
    for (const row of data) reportIdByDate.set(row.report_date, row.id)
    console.log(`daily_reports insert ${Math.min(i + CHUNK, dailyReports.length)}/${dailyReports.length}`)
  }

  const entryRows = []
  for (const [isoDate, entries] of entriesByDate) {
    const reportId = reportIdByDate.get(isoDate)
    entries.forEach((e, sortOrder) => {
      entryRows.push({ report_id: reportId, entry_time: e.time, content: e.content, sort_order: sortOrder })
    })
  }
  for (let i = 0; i < entryRows.length; i += CHUNK) {
    const chunk = entryRows.slice(i, i + CHUNK)
    const { error } = await supabase.from('report_entries').insert(chunk)
    if (error) throw error
    console.log(`report_entries insert ${Math.min(i + CHUNK, entryRows.length)}/${entryRows.length}`)
  }

  console.log('移行完了。')
}

main().catch((err) => {
  console.error('失敗:', err)
  process.exit(1)
})
