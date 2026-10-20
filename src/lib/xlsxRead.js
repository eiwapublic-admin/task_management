// xlsx（OOXML）の読み取り（ZIP の展開とシート XML のセル値）。2026-10-20 に廃棄物のExcel取込
// （wasteExcelImport.js）から切り出し、検針の出力の照合（FileMaker の xlsx との突き合わせ）でも使う。
// npm の `xlsx` パッケージは未修正の脆弱性を抱えるため使わず、必要な範囲だけを自前で持つ
// （経緯は wasteExcelImport.js の冒頭）。ブラウザの DecompressionStream・DOMParser を使う。

const CENTRAL_DIR_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

export function findEndOfCentralDirectory(view) {
  const maxCommentLen = 65535
  const minPos = Math.max(0, view.byteLength - 22 - maxCommentLen)
  for (let i = view.byteLength - 22; i >= minPos; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i
  }
  throw new Error('ZIP形式として読み取れませんでした（.xlsxファイルではない可能性があります）')
}

// 中央ディレクトリを走査してエントリ一覧（ファイル名→圧縮方式・サイズ・ローカルヘッダ位置）を作る
export function listZipEntries(buffer) {
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
export async function readZipEntry(buffer, entry) {
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

export function parseSharedStrings(xmlText) {
  if (!xmlText) return []
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  return [...doc.getElementsByTagName('si')].map((si) =>
    [...si.getElementsByTagName('t')].map((t) => t.textContent || '').join('')
  )
}

export function colIndexOf(ref) {
  const letters = /^([A-Z]+)\d+$/.exec(ref)?.[1] || ''
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

// シートXMLを { 行番号 -> Map(列番号 -> 値) } に変換する（数値セルはNumberに、
// 文字列セル（共有文字列・インライン文字列）はstringのまま返す）
export function parseSheetRows(xmlText, sharedStrings) {
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

// ブック内のシートXMLのパスを、Excel上のタブの並び順で返す（workbook.xml と
// そのリレーション定義から引く）。以前は xl/worksheets/sheet1.xml 決め打ちだったが、
// タブが複数ある・並べ替えたブックでは sheet1.xml が先頭タブとは限らないため
export async function listSheetPaths(buffer, entries, decoder) {
  const wbEntry = entries.get('xl/workbook.xml')
  const relsEntry = entries.get('xl/_rels/workbook.xml.rels')
  const fallback = [...entries.keys()].filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n)).sort()
  if (!wbEntry || !relsEntry) return fallback

  const [wbBytes, relsBytes] = await Promise.all([readZipEntry(buffer, wbEntry), readZipEntry(buffer, relsEntry)])
  const parser = new DOMParser()
  const relsDoc = parser.parseFromString(decoder.decode(relsBytes), 'application/xml')
  const targets = new Map()
  for (const rel of relsDoc.getElementsByTagName('Relationship')) {
    const target = rel.getAttribute('Target') || ''
    // Target は xl/ からの相対パス（例: worksheets/sheet1.xml）か、/xl/... の絶対パス
    targets.set(rel.getAttribute('Id'), target.startsWith('/') ? target.slice(1) : `xl/${target}`)
  }
  const wbDoc = parser.parseFromString(decoder.decode(wbBytes), 'application/xml')
  const paths = []
  for (const sheet of wbDoc.getElementsByTagName('sheet')) {
    const rid =
      sheet.getAttribute('r:id') ||
      sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
    const path = targets.get(rid)
    if (path && entries.has(path)) paths.push(path)
  }
  return paths.length ? paths : fallback
}

// 先頭シート（タブの並びで最初）を「行の配列（各行は列の配列。空セルは null）」で返す。
// 日付・時刻のセルは Excel の通し番号（日付は1899-12-30からの日数、時刻は1日に対する割合）のまま
export async function readFirstSheetRows(buffer) {
  if (typeof DecompressionStream === 'undefined' || typeof DOMParser === 'undefined') {
    throw new Error('このブラウザではExcelファイルの読み取りに対応していません。最新のブラウザでお試しください。')
  }
  let entries
  try {
    entries = listZipEntries(buffer)
  } catch {
    throw new Error('Excelファイルとして読み取れませんでした（.xlsx形式かご確認ください）')
  }
  const decoder = new TextDecoder('utf-8')
  const [first] = await listSheetPaths(buffer, entries, decoder)
  if (!first) throw new Error('Excelファイルにシートが見つかりません')
  const sharedBytes = entries.has('xl/sharedStrings.xml')
    ? await readZipEntry(buffer, entries.get('xl/sharedStrings.xml'))
    : null
  const sharedStrings = parseSharedStrings(sharedBytes ? decoder.decode(sharedBytes) : '')
  const rows = parseSheetRows(decoder.decode(await readZipEntry(buffer, entries.get(first))), sharedStrings)
  const maxRow = Math.max(0, ...rows.keys())
  const out = []
  for (let r = 1; r <= maxRow; r++) {
    const cells = rows.get(r) || new Map()
    const maxCol = Math.max(0, ...cells.keys())
    const row = []
    for (let c = 1; c <= maxCol; c++) row.push(cells.has(c) ? cells.get(c) : null)
    out.push(row)
  }
  return out
}
