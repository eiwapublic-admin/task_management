import { daysInMonth } from './reports'
import { listZipEntries, readZipEntry, parseSharedStrings, parseSheetRows, listSheetPaths } from './xlsxRead'

// 廃棄物実測集計表のExcel取込（2026-09-09〜。docs/waste-plan.md 5-2改訂）。
// 手書きシートのスキャン読み取り（Claude Vision）が実際の筆跡でうまく読み取れなかったため、
// 依頼元がAIチャット等で手書き内容をExcel化したものをそのまま読み取る方式に変更した。
//
// xlsx（OOXML）は中身がZIPのため、パースには本来ライブラリを使うのが簡単だが、npm公開の
// `xlsx`パッケージは未修正の高リスク脆弱性（プロトタイプ汚染・ReDoS）を抱えており、
// 修正版はSheetJS自社CDN配布のみでこの環境からは取得できない。読み取る値は「日×1〜7階の
// 実測値（kg）」だけで形式もdocs/waste-plan.md 2章のとおり固定のため、依存追加を避け、
// 必要な範囲（ZIP展開・シートXMLの数値セル読み取り）だけを自前実装する（2026-10-20 に検針の照合でも
// 使うため、ZIP・シートの読み取り部分は src/lib/xlsxRead.js へ切り出した）。

// 「1F」だけでなく「1階」「１階」「１Ｆ」も受け付ける（2026-09-30。AIチャットがGoogle
// スプレッドシートで作った表は見出しが「1階」〜「7階」だったため読み取れなかった）。
// 全角は normalizeLabel（NFKC）で半角にそろえてから判定する
const FLOOR_LABEL = /^([1-7])\s*(?:F|階)$/i

function normalizeLabel(value) {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

function assertBrowserSupport() {
  if (typeof DecompressionStream === 'undefined' || typeof DOMParser === 'undefined') {
    throw new Error('このブラウザではExcelファイルの読み取りに対応していません。最新のブラウザでお試しください。')
  }
}

// 「日・曜日・1F〜7F・合計」の見出し行を探し、1F〜7F列の位置を返す
// （docs/waste-plan.md 2章のとおり列の並びは固定。日列は1F列の2つ左、曜日列はその右隣）
function findFloorHeader(rows) {
  for (const rowNum of [...rows.keys()].sort((a, b) => a - b)) {
    const cells = rows.get(rowNum)
    const found = new Map()
    for (const [colIdx, value] of cells) {
      const m = typeof value === 'string' ? FLOOR_LABEL.exec(normalizeLabel(value)) : null
      if (m) found.set(colIdx, m[1])
    }
    if (found.size >= 7) return { headerRowNum: rowNum, floorCols: found }
  }
  return null
}

/**
 * 廃棄物実測集計表のExcelファイルから、日×階の実測値を読み取る。
 * @param {File} file .xlsxファイル
 * @param {string} targetMonth 対象月 'YYYY-MM'（見出しの年月表示は読み取らず、
 *   モーダルでユーザーが選んだ月をそのまま使う。日付の組み立てにだけ使う）
 * @returns {{ rows: { record_date: string, floor: string, weight_kg: number }[] }}
 */
export async function parseWasteExcelFile(file, targetMonth) {
  if (!/\.xlsx$/i.test(file.name || '')) {
    throw new Error('.xlsx形式のファイルを選んでください')
  }
  return parseWasteExcelBuffer(await file.arrayBuffer(), targetMonth)
}

/**
 * parseWasteExcelFile の本体。Googleドライブから取得したファイル（2026-09-30〜。
 * スプレッドシートはサーバー側で.xlsxに書き出して返す）もここで読み取る。
 * @param {ArrayBuffer} buffer .xlsxファイルの中身
 * @param {string} targetMonth 対象月 'YYYY-MM'
 */
export async function parseWasteExcelBuffer(buffer, targetMonth) {
  assertBrowserSupport()
  let entries
  try {
    entries = listZipEntries(buffer)
  } catch {
    throw new Error('Excelファイルとして読み取れませんでした（.xlsx形式かご確認ください）')
  }

  const decoder = new TextDecoder('utf-8')
  const sheetPaths = await listSheetPaths(buffer, entries, decoder)
  if (sheetPaths.length === 0) throw new Error('Excelファイルの形式が想定と異なります（シートが見つかりません）')

  const sharedBytes = entries.has('xl/sharedStrings.xml')
    ? await readZipEntry(buffer, entries.get('xl/sharedStrings.xml'))
    : null
  const sharedStrings = parseSharedStrings(sharedBytes ? decoder.decode(sharedBytes) : '')

  // タブの並び順に見て、1〜7階の見出し行を持つ最初のシートを使う
  let rows = null
  let header = null
  for (const path of sheetPaths) {
    const sheetRows = parseSheetRows(decoder.decode(await readZipEntry(buffer, entries.get(path))), sharedStrings)
    const found = findFloorHeader(sheetRows)
    if (found) {
      rows = sheetRows
      header = found
      break
    }
  }
  if (!header) {
    throw new Error('見出し行（1階〜7階）が見つかりませんでした。想定と異なる形式のファイルです。')
  }
  const floorColEntries = [...header.floorCols.entries()].sort((a, b) => a[0] - b[0])
  const dayCol = floorColEntries[0][0] - 2

  const lastDay = daysInMonth(targetMonth)
  const outRows = []
  for (const rowNum of [...rows.keys()].sort((a, b) => a - b)) {
    if (rowNum <= header.headerRowNum) continue
    const cells = rows.get(rowNum)
    const day = Number(cells.get(dayCol))
    if (!Number.isInteger(day) || day < 1 || day > lastDay) break

    const recordDate = `${targetMonth}-${String(day).padStart(2, '0')}`
    for (const [colIdx, floorDigit] of floorColEntries) {
      const raw = cells.get(colIdx)
      if (raw === null || raw === undefined || raw === '') continue
      const weight = Number(raw)
      if (!Number.isFinite(weight) || weight < 0) continue
      outRows.push({ record_date: recordDate, floor: floorDigit, weight_kg: Math.round(weight * 100) / 100 })
    }
  }

  return { rows: outRows }
}
