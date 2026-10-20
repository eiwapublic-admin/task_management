// 検針写真のバーコード（Code39 `*メータ番号*`）を読む（2026-10-20〜。docs/meter-plan.md 3-2）。
// ZXing（無償・端末内で処理、外部へは送らない）の Code39 だけを使う。
// バーコードは写真の下側に小さく写るので、縮小前の元画像で読む。読めなければ
// 下半分・半分の大きさ・90度回転（横向きに撮った写真）の順に試す。
// パッケージの入口（index）から読むと使わない形式まで全部入って450KBになるので、必要な部品だけ直接読む
import BinaryBitmap from '@zxing/library/esm/core/BinaryBitmap'
import DecodeHintType from '@zxing/library/esm/core/DecodeHintType'
import HybridBinarizer from '@zxing/library/esm/core/common/HybridBinarizer'
import RGBLuminanceSource from '@zxing/library/esm/core/RGBLuminanceSource'
import Code39Reader from '@zxing/library/esm/core/oned/Code39Reader'

const HINTS = new Map([[DecodeHintType.TRY_HARDER, true]])
// 元画像が大きすぎると時間とメモリを食うので、長辺をここまで落としてから読む（バーの太さは十分残る）
const MAX_EDGE = 2400

function decode(luma, width, height) {
  try {
    const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(luma, width, height)))
    const text = new Code39Reader().decode(bitmap, HINTS).getText()
    return text ? text.trim() : null
  } catch {
    return null
  }
}

function crop(luma, width, top, bottom) {
  return luma.slice(top * width, bottom * width)
}

function half(luma, width, height) {
  const w = Math.floor(width / 2)
  const h = Math.floor(height / 2)
  const out = new Uint8ClampedArray(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = 2 * y * width + 2 * x
      out[y * w + x] = (luma[i] + luma[i + 1] + luma[i + width] + luma[i + width + 1]) >> 2
    }
  }
  return { luma: out, width: w, height: h }
}

// 時計回りに90度回す
function rotate(luma, width, height) {
  const out = new Uint8ClampedArray(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out[x * height + (height - 1 - y)] = luma[y * width + x]
  }
  return { luma: out, width: height, height: width }
}

/**
 * 輝度（1画素1バイト）の画像から Code39 を読む。読めなければ null。
 * Node でも動くように DOM を使わない（scripts での確認用）。
 */
export function readCode39(luma, width, height) {
  const tries = (img) => {
    const found = decode(img.luma, img.width, img.height)
    if (found) return found
    const top = Math.floor(img.height / 2)
    const lower = decode(crop(img.luma, img.width, top, img.height), img.width, img.height - top)
    if (lower) return lower
    if (img.width >= 600) {
      const h = half(img.luma, img.width, img.height)
      return decode(h.luma, h.width, h.height)
    }
    return null
  }
  const img = { luma, width, height }
  return tries(img) || tries(rotate(luma, width, height))
}

/**
 * 写真ファイルから Code39 を読む（ブラウザ用）。EXIF の向きは反映してから読む。
 * @returns {Promise<string|null>}
 */
export async function readMeterBarcode(file) {
  let bitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return null
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()
  const { data } = ctx.getImageData(0, 0, width, height)
  const luma = new Uint8ClampedArray(width * height)
  for (let i = 0, j = 0; j < luma.length; i += 4, j++) {
    luma[j] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000
  }
  canvas.width = 0
  return readCode39(luma, width, height)
}
