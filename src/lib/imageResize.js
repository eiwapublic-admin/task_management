// 画像をアップロード前にブラウザ側で縮小する（2026-08-04〜）。
//
// 目的は2つ。
//  1. 保管容量を抑える（無料枠1GBで長く運用するため。docs/daily-report-plan.md 4-3参照）
//  2. モバイル回線での送信量を減らす（原本のまま送ると1枚数MBになる）
//
// 用途ごとに解像度を変える。作業風景は720pxで十分だが、不正駐車はナンバーの
// 判読が目的なので1280pxを確保する（枚数が少なく容量への影響は軽微）。

export const RESIZE_PRESETS = {
  work: { maxEdge: 720, quality: 0.8, thumb: false },
  parking: { maxEdge: 1280, quality: 0.8, thumb: true },
  chlorine: { maxEdge: 720, quality: 0.8, thumb: false },
}

// 一覧に写真が並ぶ用途だけサムネイルを作る
const THUMB_EDGE = 320
const THUMB_QUALITY = 0.7

// 画像を読み込む。iPhone の HEIC は input[type=file] 経由で JPEG に変換されて渡る
// ことが多いが、変換されずに来た場合はブラウザがデコードできず失敗する。
// その場合は縮小せず原本のまま送る（保存はできるようにする）。
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('画像を読み込めませんでした'))
    }
    img.src = url
  })
}

// 長辺が maxEdge を超える場合のみ縮小した寸法を返す（元が小さければ拡大しない）
function fitSize(width, height, maxEdge) {
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { width, height }
  const scale = maxEdge / longest
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('画像の変換に失敗しました'))),
      'image/jpeg',
      quality
    )
  })
}

async function drawResized(img, maxEdge, quality) {
  const { width, height } = fitSize(img.naturalWidth, img.naturalHeight, maxEdge)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  // 縮小時の画質を優先する（既定のままだとギザつくことがある）
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, width, height)
  const blob = await canvasToBlob(canvas, quality)
  return { blob, width, height }
}

/**
 * アップロード用に画像を整える。
 * @param {File} file 選択・撮影されたファイル
 * @param {'work'|'parking'|'chlorine'} category 用途
 * @returns {{file: Blob, thumb: Blob|null, width: number|null, height: number|null, resized: boolean}}
 */
export async function prepareImage(file, category = 'work') {
  const preset = RESIZE_PRESETS[category] || RESIZE_PRESETS.work

  // PDF は縮小せずそのまま送る（資料としてそのまま残す）
  if (file.type === 'application/pdf') {
    return { file, thumb: null, width: null, height: null, resized: false }
  }

  let img
  try {
    img = await loadImage(file)
  } catch {
    // デコードできない形式（変換されなかった HEIC 等）は原本のまま送る。
    // ここで失敗させると写真がまったく残せなくなるため、縮小を諦めて保存を優先する。
    return { file, thumb: null, width: null, height: null, resized: false }
  }

  const { blob, width, height } = await drawResized(img, preset.maxEdge, preset.quality)

  let thumb = null
  if (preset.thumb) {
    try {
      const t = await drawResized(img, THUMB_EDGE, THUMB_QUALITY)
      thumb = t.blob
    } catch {
      thumb = null // サムネイルが作れなくても本体は保存する
    }
  }

  // 縮小した結果が元より大きくなる場合（既に小さい JPEG 等）は原本を使う
  if (blob.size >= file.size && Math.max(img.naturalWidth, img.naturalHeight) <= preset.maxEdge) {
    return { file, thumb, width: img.naturalWidth, height: img.naturalHeight, resized: false }
  }

  return { file: blob, thumb, width, height, resized: true }
}

// バイト数をMB単位で整形する（写真の下に表示する縮小後サイズに使う）
export function formatMB(bytes) {
  if (!bytes) return null
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

// バイト数を読みやすく整形する（使用量の表示に使う）
export function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** i
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}
