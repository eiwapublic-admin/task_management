// PDFの1ページ目をサムネイル画像に変換する（2026-08-31追加）。
// 「PDF登録時には自動的に縮小した画像が自動的に貼り付けられるようにする」という依頼に対応するため、
// 原本がPDFの場合・PDF版を登録した場合、ブラウザ側でこのファイルを使って自動生成する。
//
// pdfjs-dist は単体でも数百KB あり、資料テンプレート画面を開かないユーザーにまで
// 毎回配信するのは無駄が大きいため、実際にPDFの縮小が必要になった時点で動的import
// する（Viteが自動でこのライブラリだけ別チャンクに分けてくれる）。
// pdfjs はワーカースレッドで解析するため、そのワーカーファイルの置き場所を
// GlobalWorkerOptions.workerSrc に指定する必要がある（Vite の ?url でビルド成果物のURLを取る）。

const THUMB_EDGE = 480
const THUMB_QUALITY = 0.75

let pdfjsLibPromise = null
function loadPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([pdfjsLib, workerUrlModule]) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrlModule.default
      return pdfjsLib
    })
  }
  return pdfjsLibPromise
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('サムネイルの生成に失敗しました'))),
      'image/jpeg',
      quality
    )
  })
}

// file: PDFのFileまたはBlob。戻り値は縮小したJPEGのBlob
export async function renderPdfFirstPageToBlob(file) {
  const pdfjsLib = await loadPdfjs()
  const data = await file.arrayBuffer()
  // 破棄（ワーカー終了含む）は PDFDocumentProxy ではなく、getDocument() が返す
  // loadingTask 側の destroy() で行う（PDFDocumentProxy 自体には destroy が無い）
  const loadingTask = pdfjsLib.getDocument({ data })
  try {
    const pdf = await loadingTask.promise
    const page = await pdf.getPage(1)
    const unscaled = page.getViewport({ scale: 1 })
    const scale = THUMB_EDGE / Math.max(unscaled.width, unscaled.height)
    const viewport = page.getViewport({ scale: Math.min(scale, 1) })

    const canvas = document.createElement('canvas')
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    const ctx = canvas.getContext('2d')
    await page.render({ canvasContext: ctx, viewport }).promise

    return await canvasToBlob(canvas, THUMB_QUALITY)
  } finally {
    await loadingTask.destroy()
  }
}
