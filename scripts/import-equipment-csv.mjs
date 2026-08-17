#!/usr/bin/env node
// 備品：入出庫データの移行スクリプト（docs/equipment-plan.md 8-2）。ローカル実行専用（CIには載せない）。
// FileMaker から書き出した「入出庫データ」CSV（UTF-8・CRLF、ダブルクォートによる引用あり）を読み、
// legacy_txn_id（CSVの「入出荷ID」）を突合キーに upsert する。何度流しても二重登録にならない。
//
// 使い方:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/import-equipment-csv.mjs <CSVパス> [--dry-run]
//
// 取込方針（8-4）:
//   - 入出庫数量が両方とも空/0の行（id726）は在庫影響ゼロのため取り込まない（8-4(7)）
//   - 出庫+在庫調整（id474）は在庫調整の符号ルール（マイナス=在庫調整のみ）に合わせ、
//     kind='in'・quantity=-4 へ正規化し、テナント欄も対象外にする（8-4(6)）
//   - reason='tenant'（テナント設置）の行は floor/tenant_name 等をCSVの文字列ではなく
//     equipment_tenants の値で確定させる（アプリ本体の登録APIと同じ扱い。3-4・4-1）
//   - reason が tenant 以外でも請求先コードが入っている行（過去の分類のゆらぎ。例:
//     共用部設置だが特定テナント向けだった記録）はそのまま参照情報として取り込む
//     （新規入替=replace で同様のケースがあった前例と同じ方針。8-4(1)(2)）。ただし
//     billing_code_かreasonを書き換えて「テナント設置」扱いにはしない＝当時の分類を尊重する

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

// ---- 最小限の RFC4180 CSV パーサ（CRLF/CR/LF いずれの改行にも対応。ダブルクォート引用・
//      エスケープ（""）・引用内の改行やカンマに対応する） ----
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }
    if (c === '"') {
      inQuotes = true
      continue
    }
    if (c === ',') {
      row.push(field)
      field = ''
      continue
    }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
      continue
    }
    field += c
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (row.length > 1 || row[0] !== '') rows.push(row)
  }
  return rows
}

const REASON_JA_TO_CODE = {
  調達: 'procure',
  繰延登録: 'deferred',
  在庫調整: 'adjust',
  テナント設置: 'tenant',
  共用部設置: 'common',
  新規入替: 'replace',
  不良品処分: 'discard',
}

// JST の 'YYYY/MM/DD' + 'H:MM[:SS]' を UTC の ISO 文字列に変換する
function jstToIso(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('/').map(Number)
  const parts = (timeStr || '0:00').split(':').map(Number)
  const [hh, mm, ss] = [parts[0] || 0, parts[1] || 0, parts[2] || 0]
  return new Date(Date.UTC(y, m - 1, d, hh, mm, ss) - 9 * 3600 * 1000).toISOString()
}

function trimOrNull(v) {
  const t = (v || '').trim()
  return t || null
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const csvPath = args.find((a) => !a.startsWith('--'))
  if (!csvPath) {
    console.error('使い方: node scripts/import-equipment-csv.mjs <CSVパス> [--dry-run]')
    process.exit(1)
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('環境変数 SUPABASE_URL / SUPABASE_SERVICE_KEY が必要です')
    process.exit(1)
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const text = readFileSync(csvPath, 'utf-8')
  const table = parseCsv(text)
  const header = table[0]
  const dataRows = table.slice(1).map((cols) => Object.fromEntries(header.map((h, i) => [h, cols[i] ?? ''])))
  console.log(`CSV読込: ${dataRows.length}件`)

  const { data: items, error: itemsErr } = await supabase.from('equipment_items').select('id, item_no')
  if (itemsErr) throw itemsErr
  const itemByNo = new Map(items.map((i) => [String(i.item_no), i]))

  const { data: tenants, error: tenantsErr } = await supabase
    .from('equipment_tenants')
    .select('id, billing_code, name, short_name, floor')
  if (tenantsErr) throw tenantsErr
  const tenantByCode = new Map(tenants.filter((t) => t.billing_code).map((t) => [t.billing_code, t]))

  const rowsToUpsert = []
  const skipped = []
  const errors = []

  for (const r of dataRows) {
    const legacyId = Number(r['入出荷ID'])
    if (!Number.isInteger(legacyId)) {
      errors.push(`入出荷IDが不正: ${JSON.stringify(r)}`)
      continue
    }

    const inQty = trimOrNull(r['入庫数量'])
    const outQty = trimOrNull(r['出庫数量'])
    // 8-4(7): 入出庫数量ともに空、または「0」（id726）は在庫影響ゼロのため取り込まない
    if ((!inQty || inQty === '0') && (!outQty || outQty === '0')) {
      skipped.push({ legacyId, reason: '入出庫数量が両方とも空/0（8-4(7)）' })
      continue
    }

    const kindJa = r['入出庫区分']
    let kind = kindJa === '入庫' ? 'in' : kindJa === '出庫' ? 'out' : null
    if (!kind) {
      errors.push(`入出庫区分が不正: ${legacyId} = ${kindJa}`)
      continue
    }

    const reasonJa = r['入出庫理由']
    const reason = REASON_JA_TO_CODE[reasonJa]
    if (!reason) {
      errors.push(`入出庫理由が不正: ${legacyId} = ${reasonJa}`)
      continue
    }

    let quantity = kind === 'in' ? Number(inQty) : Number(outQty)
    let stripTenantFields = false
    let noteSuffix = ''
    if (legacyId === 474) {
      // 8-4(6): 出庫+在庫調整 → in・quantity=-4 に正規化。テナント情報（請求先・設置階・設置先）は
      // 在庫調整には持たせない方針のため取り込まず、元テナントが分かるよう備考へ注記を足す
      kind = 'in'
      quantity = -Math.abs(quantity)
      stripTenantFields = true
      noteSuffix = `（移行時に出庫記録から統合。元テナント: ${trimOrNull(r['設置先'])}）`
    }
    if (!Number.isFinite(quantity) || quantity === 0) {
      errors.push(`数量が不正: ${legacyId} = ${quantity}`)
      continue
    }

    const itemNo = trimOrNull(r['備品ID'])
    const item = itemNo ? itemByNo.get(itemNo) : null
    if (!item) {
      errors.push(`備品IDが見つかりません: ${legacyId} = ${itemNo}`)
      continue
    }

    const billingCode = stripTenantFields ? null : trimOrNull(r['設置先請求先コード'])
    const tenant = billingCode ? tenantByCode.get(billingCode) : null
    if (billingCode && !tenant) {
      errors.push(`請求先コードが見つかりません: ${legacyId} = ${billingCode}`)
      continue
    }

    const isTenantReason = reason === 'tenant'
    const floor = legacyId === 474 ? null : isTenantReason ? (tenant?.floor ?? trimOrNull(r['設置階'])) : trimOrNull(r['設置階'])
    const location = legacyId === 474 || isTenantReason ? null : trimOrNull(r['設置先'])

    const occurredAt = jstToIso(r['入出庫日付'], r['入出庫時刻'])
    const receivedTs = trimOrNull(r['受領タイムスタンプ'])
    // 「?」等の破損値が一部の行にあるため、'YYYY/MM/DD H:MM[:SS]' 形式でなければ signed_at は空で取り込む
    const signedAt =
      isTenantReason && receivedTs && /^\d{4}\/\d{2}\/\d{2} \d{1,2}:\d{2}(:\d{2})?$/.test(receivedTs)
        ? jstToIso(...receivedTs.split(' '))
        : null

    rowsToUpsert.push({
      legacy_txn_id: legacyId,
      item_id: item.id,
      kind,
      reason,
      occurred_at: occurredAt,
      quantity,
      supplier: trimOrNull(r['調達先']),
      tenant_id: tenant?.id ?? null,
      tenant_code: tenant?.billing_code ?? null,
      tenant_name: tenant?.name ?? null,
      tenant_short_name: tenant?.short_name ?? null,
      floor,
      location,
      staff_name: trimOrNull(r['担当者']),
      signed_at: signedAt,
      note: trimOrNull(`${trimOrNull(r['備考']) || ''}${noteSuffix}`),
    })
  }

  console.log(`取込対象: ${rowsToUpsert.length}件 / スキップ: ${skipped.length}件 / エラー: ${errors.length}件`)
  if (skipped.length) console.log('スキップ:', skipped)
  if (errors.length) {
    console.error('エラーがあるため中止します:')
    errors.forEach((e) => console.error(' -', e))
    process.exit(1)
  }

  if (dryRun) {
    console.log('--dry-run のため書き込みは行いません。サンプル（先頭3件）:')
    console.log(JSON.stringify(rowsToUpsert.slice(0, 3), null, 2))
    return
  }

  const CHUNK = 200
  for (let i = 0; i < rowsToUpsert.length; i += CHUNK) {
    const chunk = rowsToUpsert.slice(i, i + CHUNK)
    const { error } = await supabase.from('equipment_transactions').upsert(chunk, { onConflict: 'legacy_txn_id' })
    if (error) throw error
    console.log(`upsert ${Math.min(i + CHUNK, rowsToUpsert.length)}/${rowsToUpsert.length}`)
  }

  // 検証（8-2）: 各備品の在庫（sum(in)-sum(out)）を表示する。CSV側の在庫数との一致確認は
  // 実行者が別途、備品マスタの実データと突き合わせて確認すること
  const { data: stock, error: stockErr } = await supabase
    .from('equipment_stock')
    .select('item_id, stock_qty')
  if (stockErr) throw stockErr
  console.log('取込完了。現在の在庫:')
  console.table(stock)
}

main().catch((err) => {
  console.error('失敗:', err)
  process.exit(1)
})
