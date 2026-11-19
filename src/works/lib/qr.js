// QR コードの作成（掲示物用）と読み取り（打刻用）。ZXing（無償・端末内で処理、外部へは送らない）。
// パッケージの入口から読むと使わない形式まで全部入って重くなるので、QR の部品だけを直接読む（src/lib/barcode.js と同じ）
import Encoder from '@zxing/library/esm/core/qrcode/encoder/Encoder'
import ErrorCorrectionLevel from '@zxing/library/esm/core/qrcode/decoder/ErrorCorrectionLevel'
import EncodeHintType from '@zxing/library/esm/core/EncodeHintType'
import QRCodeReader from '@zxing/library/esm/core/qrcode/QRCodeReader'
import BinaryBitmap from '@zxing/library/esm/core/BinaryBitmap'
import HybridBinarizer from '@zxing/library/esm/core/common/HybridBinarizer'
import RGBLuminanceSource from '@zxing/library/esm/core/RGBLuminanceSource'
import DecodeHintType from '@zxing/library/esm/core/DecodeHintType'

// 文字列 → QR のマス目（true=黒）。周りの余白（quiet zone）は含まない
export function qrMatrix(text) {
  const hints = new Map([[EncodeHintType.CHARACTER_SET, 'UTF-8']])
  const m = Encoder.encode(text, ErrorCorrectionLevel.M, hints).getMatrix()
  const size = m.getWidth()
  const rows = []
  for (let y = 0; y < size; y++) {
    const row = []
    for (let x = 0; x < size; x++) row.push(m.get(x, y) === 1)
    rows.push(row)
  }
  return rows
}

// 文字列 → QR の PNG（data URL）。掲示物の PDF 化（html2canvas）でもそのまま写るよう画像にする
export function qrDataUrl(text, px = 600) {
  const rows = qrMatrix(text)
  const quiet = 4
  const n = rows.length + quiet * 2
  const cell = Math.max(1, Math.floor(px / n))
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = cell * n
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#000'
  rows.forEach((row, y) => row.forEach((on, x) => on && ctx.fillRect((x + quiet) * cell, (y + quiet) * cell, cell, cell)))
  return canvas.toDataURL('image/png')
}

const READ_HINTS = new Map([[DecodeHintType.TRY_HARDER, true]])
const reader = new QRCodeReader()

// 輝度（1 画素 1 バイト）の画像から QR を読む。読めなければ null
export function readQr(luma, width, height) {
  try {
    const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(luma, width, height)))
    return reader.decode(bitmap, READ_HINTS).getText()
  } catch {
    return null
  } finally {
    reader.reset()
  }
}

// カメラの映像（video 要素）の 1 コマから QR を読む
export function readQrFromVideo(video, canvas, mode = 'center') {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return null
  // center … 中央の正方形（近づけたとき）。full … 画面全体を縮小（離れていて小さく写るとき）
  const sx = mode === 'full' ? 0 : (vw - Math.min(vw, vh)) / 2
  const sy = mode === 'full' ? 0 : (vh - Math.min(vw, vh)) / 2
  const sw = mode === 'full' ? vw : Math.min(vw, vh)
  const sh = mode === 'full' ? vh : Math.min(vw, vh)
  const scale = Math.min(1, 800 / Math.max(sw, sh))
  const w = Math.round(sw * scale)
  const h = Math.round(sh * scale)
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h)
  const { data } = ctx.getImageData(0, 0, w, h)
  const luma = new Uint8ClampedArray(w * h)
  for (let i = 0, j = 0; j < luma.length; i += 4, j++) luma[j] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000
  return readQr(luma, w, h)
}

// 打刻用 QR の中身（https://…/p?c=<現場コード>&k=<in|out>&t=<合言葉>）を取り出す。eWorks の QR でなければ null
export function parsePunchQr(text) {
  try {
    const u = new URL(text)
    if (u.pathname !== '/p') return null
    const c = u.searchParams.get('c')
    const k = u.searchParams.get('k')
    const t = u.searchParams.get('t')
    if (!c || !t || (k !== 'in' && k !== 'out')) return null
    return { c, k, t }
  } catch {
    return null
  }
}

export function punchUrl(origin, code, kind, token) {
  return `${origin}/p?${new URLSearchParams({ c: code, k: kind, t: token })}`
}
