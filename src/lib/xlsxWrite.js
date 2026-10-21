// xlsx（OOXML）の書き出しの下回り（2026-10-21〜。テナント一覧表・緊急連絡先一覧表）。
// npm の `xlsx` パッケージは使わない方針（xlsxRead.js の冒頭）なので、雛形の xlsx を展開してシートの XML を
// 書き換え、ZIP に詰め直すところまでを自前で持つ。ZIP は無圧縮（stored）で詰める（Excel はそのまま開ける）

import { listZipEntries, readZipEntry } from './xlsxRead'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// 雛形の xlsx を読み、ファイル名 → 中身（Uint8Array）の Map にする（並びは元のまま）
export async function unzipXlsx(buffer) {
  const files = new Map()
  for (const [name, entry] of listZipEntries(buffer)) files.set(name, await readZipEntry(buffer, entry))
  return files
}

// ファイル名 → 中身の Map を無圧縮の ZIP にする
export function zipFiles(files) {
  const enc = new TextEncoder()
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, data] of files) {
    const nameBytes = enc.encode(name)
    const crc = crc32(data)
    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x0800, true) // ファイル名は UTF-8
    lv.setUint16(8, 0, true) // 無圧縮
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)

    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)

    locals.push(local, data)
    centrals.push(central)
    offset += local.length + data.length
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, centrals.length, true)
  ev.setUint16(10, centrals.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  return new Blob([...locals, ...centrals, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

export function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

// 列番号（1始まり）→ 列名（A, B, …, AC）
export function colName(n) {
  let s = ''
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

// 'YYYY-MM-DD' → Excel の日付シリアル値（1900年基準）
export function excelDate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000
}

// 1つのセルの XML。value が null・空なら書式だけのセル
// value: 文字列 / 数 / { date: 'YYYY-MM-DD' } / { formula: 'MAX(N5:N9)' }
export function cellXml(ref, style, value) {
  const s = style != null ? ` s="${style}"` : ''
  if (value == null || value === '') return `<c r="${ref}"${s}/>`
  if (typeof value === 'number') return `<c r="${ref}"${s}><v>${value}</v></c>`
  if (typeof value === 'object' && value.date) return `<c r="${ref}"${s}><v>${excelDate(value.date)}</v></c>`
  if (typeof value === 'object' && value.formula) return `<c r="${ref}"${s}><f>${escapeXml(value.formula)}</f></c>`
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
}

// 画面からファイルとして保存させる
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
