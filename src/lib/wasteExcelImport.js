import { daysInMonth } from './reports'

// 廃棄物実測集計表のExcel取込（2026-09-09〜。docs/waste-plan.md 5-2改訂）。
// 手書きシートのスキャン読み取り（Claude Vision）が実際の筆跡でうまく読み取れなかったため、
// 依頼元がAIチャット等で手書き内容をExcel化したものをそのまま読み取る方式に変更した。
//
// xlsx（OOXML）は中身がZIPのため、パースには本来ライブラリを使うのが簡単だが、npm公開の
// `xlsx`パッケージは未修正の高リスク脆弱性（プロトタイプ汚染・ReDoS）を抱えており、
// 修正版はSheetJS自社CDN配布のみでこの環境からは取得できない。読み取る値は「日×1〜7階の
// 実測値（kg）」だけで形式もdocs/waste-plan.md 2章のとおり固定のため、依存追加を避け、
// 必要な範囲（ZIP展開・シートXMLの数値セル読み取り）だけを自前実装する。

const CENTRAL_DIR_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const FLOOR_LABEL = /^([1-7])\s*F$/i

function assertBrowserSupport() {
  if (typeof DecompressionStream === 'undefined' || typeof DOMParser === 'undefined') {
    throw new Error('このブラウザではExcelファイルの読み取りに対応していません。最新のブラウザでお試しください。')
  }
}

function findEndOfCentralDirectory(view) {
  const maxCommentLen = 65535
  const minPos = Math.max(0, view.byteLength - 22 - maxCommentLen)
  for (let i = view.byteLength - 22; i >= minPos; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i
  }
  throw new Error('ZIP形式として読み取れませんでした（.xlsxファイルではない可能性があります）')
}

// 中央ディレクトリを走査してエントリ一覧（ファイル名→圧縮方式・サイズ・ローカルヘッダ位置）を作る
function listZipEntries(buffer) {
  const view = new DataView(buffer)
  const eocdOffset = findEndOfCentralDirectory(view)
  const cdOffset = view.getUint32(eocdOffset + 16, true)
  const cdSize = view.getUint32(eocdOffset + 12, true)
  const bytes = new Uint8Array(buffer)
  const decoder = new TextDecoder('utf-8')
  const entries = new Map()

  let offset = cdOffset
  const end = cdOffset + cdSize
  while (offset < end && view.getUint32(offset, true) === CENTRAL_DIR_SIG) {
    const method = view.getUint16(offset + 10, true)
    const compSize = view.getUint32(offset + 20, true)
    const nameLen = view.getUint16(offset + 28, true)
    const extraLen = view.getUint16(offset + 30, true)
    const commentLen = view.getUint16(offset + 32, true)
    const localHeaderOffset = view.getUint32(offset + 42, true)
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen))
    entries.set(name, { method, compSize, localHeaderOffset })
    offset += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

// ローカルヘッダの実サイズ（filename・extraの長さ）は中央ディレクトリと異なる場合があるため、
// データ開始位置はローカルヘッダ自身から読み直す（圧縮後サイズ・方式は中央ディレクトリを信用する。
// ストリーミング書き込み時にローカルヘッダ側のサイズが0になるケースがあるため）
async function readZipEntry(buffer, entry) {
  const view = new DataView(buffer)
  const nameLen = view.getUint16(entry.localHeaderOffset + 26, true)
  const extraLen = view.getUint16(entry.localHeaderOffset + 28, true)
  const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen
  const compressed = new Uint8Array(buffer, dataStart, entry.compSize)

  if (entry.method === 0) return compressed.slice()
  if (entry.method === 8) {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }
  throw new Error('対応していない圧縮方式のExcelファイルです')
}

function parseSharedStrings(xmlText) {
  if (!xmlText) return []
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  return [...doc.getElementsByTagName('si')].map((si) =>
    [...si.getElementsByTagName('t')].map((t) => t.textContent || '').join('')
  )
}

function colIndexOf(ref) {
  const letters = /^([A-Z]+)\d+$/.exec(ref)?.[1] || ''
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

// シートXMLを { 行番号 -> Map(列番号 -> 値) } に変換する（数値セルはNumberに、
// 文字列セル（共有文字列・インライン文字列）はstringのまま返す）
function parseSheetRows(xmlText, sharedStrings) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  const rows = new Map()
  for (const rowEl of doc.getElementsByTagName('row')) {
    const rowNum = Number(rowEl.getAttribute('r'))
    const cells = new Map()
    for (const c of rowEl.getElementsByTagName('c')) {
      const colIdx = colIndexOf(c.getAttribute('r') || '')
      if (!colIdx) continue
      const type = c.getAttribute('t')
      let value = null
      if (type === 'inlineStr') {
        value = c.getElementsByTagName('is')[0]?.textContent || ''
      } else {
        const raw = c.getElementsByTagName('v')[0]?.textContent
        if (raw == null) value = null
        else if (type === 's') value = sharedStrings[Number(raw)] ?? ''
        else if (type === 'str' || type === 'b') value = raw
        else value = Number(raw)
      }
      cells.set(colIdx, value)
    }
    rows.set(rowNum, cells)
  }
  return rows
}

// 「日・曜日・1F〜7F・合計」の見出し行を探し、1F〜7F列の位置を返す
// （docs/waste-plan.md 2章のとおり列の並びは固定。日列は1F列の2つ左、曜日列はその右隣）
function findFloorHeader(rows) {
  for (const rowNum of [...rows.keys()].sort((a, b) => a - b)) {
    const cells = rows.get(rowNum)
    const found = new Map()
    for (const [colIdx, value] of cells) {
      const m = typeof value === 'string' ? FLOOR_LABEL.exec(value.trim()) : null
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
  assertBrowserSupport()
  if (!/\.xlsx$/i.test(file.name || '')) {
    throw new Error('.xlsx形式のファイルを選んでください')
  }

  const buffer = await file.arrayBuffer()
  let entries
  try {
    entries = listZipEntries(buffer)
  } catch {
    throw new Error('Excelファイルとして読み取れませんでした（.xlsx形式かご確認ください）')
  }

  const sheetEntry = entries.get('xl/worksheets/sheet1.xml')
  if (!sheetEntry) throw new Error('Excelファイルの形式が想定と異なります（シートが見つかりません）')

  const [sheetBytes, sharedBytes] = await Promise.all([
    readZipEntry(buffer, sheetEntry),
    entries.has('xl/sharedStrings.xml') ? readZipEntry(buffer, entries.get('xl/sharedStrings.xml')) : null,
  ])

  const decoder = new TextDecoder('utf-8')
  const sharedStrings = parseSharedStrings(sharedBytes ? decoder.decode(sharedBytes) : '')
  const rows = parseSheetRows(decoder.decode(sheetBytes), sharedStrings)

  const header = findFloorHeader(rows)
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
