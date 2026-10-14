// 写真の撮影日時を読む（2026-10-14〜。残留塩素等検査で、写真ライブラリから選んだ写真の撮影日時を
// 測定日時にするため）。依存を増やさないよう、JPEG の EXIF から日時のタグだけを読む最小限の実装。
//   1. EXIF の DateTimeOriginal（撮影日時）→ 無ければ DateTimeDigitized → DateTime（IFD0）
//   2. EXIF が読めない（HEIC・PNG・EXIF を消された画像など）ときはファイルの日時（lastModified）で代用する
// EXIF の日時はタイムゾーンを持たない「撮影した端末の現地時刻」なので、そのまま現地時刻として扱う。
// 戻り値: { local: 'YYYY-MM-DDTHH:MM'（datetime-local の値）, iso, source: 'exif' | 'file' } または null

const TAG_DATETIME = 0x0132
const TAG_EXIF_IFD = 0x8769
const TAG_DATETIME_ORIGINAL = 0x9003
const TAG_DATETIME_DIGITIZED = 0x9004

function readExifDates(buf) {
  const v = new DataView(buf)
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null // JPEG ではない
  let p = 2
  while (p + 4 <= v.byteLength) {
    if (v.getUint8(p) !== 0xff) return null
    const marker = v.getUint8(p + 1)
    const size = v.getUint16(p + 2)
    if (marker === 0xda || marker === 0xd9) return null // 画像本体に入った＝EXIF は無い
    if (marker === 0xe1 && p + 10 <= v.byteLength && v.getUint32(p + 4) === 0x45786966) {
      return parseTiff(v, p + 10, Math.min(v.byteLength, p + 2 + size))
    }
    p += 2 + size
  }
  return null
}

function parseTiff(v, start, end) {
  const little = v.getUint16(start) === 0x4949
  const u16 = (o) => v.getUint16(start + o, little)
  const u32 = (o) => v.getUint32(start + o, little)
  const ascii = (o, n) => {
    let s = ''
    for (let i = 0; i < n && start + o + i < end; i += 1) {
      const c = v.getUint8(start + o + i)
      if (c === 0) break
      s += String.fromCharCode(c)
    }
    return s
  }
  const readIfd = (offset) => {
    const out = {}
    if (start + offset + 2 > end) return out
    const count = u16(offset)
    for (let i = 0; i < count; i += 1) {
      const e = offset + 2 + i * 12
      if (start + e + 12 > end) break
      const tag = u16(e)
      const type = u16(e + 2)
      const n = u32(e + 4)
      if (type === 2) out[tag] = ascii(n > 4 ? u32(e + 8) : e + 8, n)
      else if (type === 4) out[tag] = u32(e + 8)
    }
    return out
  }
  const ifd0 = readIfd(u32(4))
  const exif = ifd0[TAG_EXIF_IFD] ? readIfd(ifd0[TAG_EXIF_IFD]) : {}
  return exif[TAG_DATETIME_ORIGINAL] || exif[TAG_DATETIME_DIGITIZED] || ifd0[TAG_DATETIME] || null
}

function pad(n) {
  return String(n).padStart(2, '0')
}

export async function readPhotoDate(file) {
  try {
    const head = await file.slice(0, 256 * 1024).arrayBuffer()
    const raw = readExifDates(head)
    const m = raw && raw.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})/)
    if (m && m[1] !== '0000') {
      const [, y, mo, d, h, mi] = m
      const local = `${y}-${mo}-${d}T${h}:${mi}`
      return { local, iso: new Date(local).toISOString(), source: 'exif' }
    }
  } catch {
    // 読めなければファイルの日時で代用する
  }
  if (!file.lastModified) return null
  const t = new Date(file.lastModified)
  const local = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`
  return { local, iso: t.toISOString(), source: 'file' }
}
