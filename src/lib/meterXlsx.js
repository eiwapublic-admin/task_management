// 検針: 提出する xlsx 2つ（「検針データ_yyyy年mm月分」「修理データ_yyyy年mm月分」）を書き出す（Phase 3。2026-11-10〜。
// docs/meter-plan.md 6章）。
//
// 後続の請求書Excel（小泉産業様の「新請求書サマリー」）は、この2つを「当月検針データ」「当月修理データ」シートに貼り、
// 列の位置で値を拾う。だから FileMaker が出していたファイルと同じ形にする:
//   - 雛形は FileMaker の出力そのもの（public/templates/meter-data.xlsx・meter-repair-data.xlsx）から、
//     見出しの行と書式（styles.xml）だけを残したもの。シート名（「分」「修理伝票」）もそのまま
//   - データの行の書式は FileMaker と同じく「列ごとに1つ」（検針データは列番号＋5、修理データも同じ並び）
//   - 空のセルは書かない（FileMaker も空欄はセル自体を出さない）。文字は inlineStr、日付・時刻は通し番号
// 中身の組み立ては meterOutput.js（検針データ）とサーバーの集計（修理データ）。ここは書き出しだけ。
// 画面と検証スクリプト（scripts/verify-meter-output.mjs）の両方から使うため、DOM には頼らない

import { colName, escapeXml, unzipXlsx, zipFiles } from './xlsxWrite.js'
import { excelSerial } from './meterOutput.js'

const DATA_STYLE_OFFSET = 6 // 雛形の cellXfs: 0〜5 は既定・見出しなど、6 から列ごとの書式

// 'YYYY-MM' → 'YYYY年M月'（ファイル名・メールの件名。FileMaker の %YYYYMM% と同じ）
export function meterFileMonth(month) {
  const [y, m] = month.split('-')
  return `${y}年${Number(m)}月`
}

export function meterDataFileName(month) {
  return `検針データ_${meterFileMonth(month)}分.xlsx`
}

export function repairDataFileName(month) {
  return `修理データ_${meterFileMonth(month)}分.xlsx`
}

function cell(ref, style, value) {
  if (value == null || value === '') return ''
  if (typeof value === 'object') {
    const serial = excelSerial(value)
    return serial == null ? '' : `<c r="${ref}" s="${style}"><v>${serial}</v></c>`
  }
  if (typeof value === 'number') return Number.isFinite(value) ? `<c r="${ref}" s="${style}"><v>${value}</v></c>` : ''
  if (typeof value === 'boolean') return `<c r="${ref}" s="${style}"><v>${value ? 1 : 0}</v></c>`
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
}

// 雛形（見出し1行だけのシート）にデータの行を足して xlsx の Blob にする
async function fillTemplate(templateBuffer, rows) {
  const files = await unzipXlsx(templateBuffer)
  const dec = new TextDecoder()
  const sheet = dec.decode(files.get('xl/worksheets/sheet1.xml'))
  const body = rows
    .map((cells, i) => {
      const r = i + 2
      const xml = cells.map((v, c) => cell(`${colName(c + 1)}${r}`, c + DATA_STYLE_OFFSET, v)).join('')
      return `<row r="${r}">${xml}</row>`
    })
    .join('')
  if (!sheet.includes('</sheetData>')) throw new Error('xlsx の雛形の形式が違います')
  files.set('xl/worksheets/sheet1.xml', new TextEncoder().encode(sheet.replace('</sheetData>', `${body}</sheetData>`)))
  return zipFiles(files)
}

/**
 * 検針データ（buildMeterOutput の結果）を xlsx にする
 * @param {{ rows: any[][] }} output
 * @param {ArrayBuffer} templateBuffer public/templates/meter-data.xlsx
 * @returns {Promise<Blob>}
 */
export function buildMeterDataXlsx(output, templateBuffer) {
  return fillTemplate(templateBuffer, output.rows)
}

// 修理データの行（7列）。修理年月は実績月（検針月度の前月）の1日、請求先略称の列には FileMaker と同じく正式名称が入る
export function repairDataRows(month, billing) {
  const [y, m] = month.split('-').map(Number)
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
  return billing.map((b) => [
    { type: 'date', value: `${prev}-01` },
    b.tenant_code || null,
    b.tenant_name || null,
    b.item_no ?? null,
    b.item_name || null,
    b.quantity ?? null,
    b.installation_summary || null,
  ])
}

/**
 * 修理データ（GET /api/meter/repair の billing）を xlsx にする
 * @returns {Promise<Blob>}
 */
export function buildRepairDataXlsx(month, billing, templateBuffer) {
  return fillTemplate(templateBuffer, repairDataRows(month, billing))
}

// 画面用: 雛形を読む
export async function fetchXlsxTemplate(name) {
  const res = await fetch(`/templates/${name}`)
  if (!res.ok) throw new Error('Excel の雛形を読み込めませんでした')
  return res.arrayBuffer()
}
