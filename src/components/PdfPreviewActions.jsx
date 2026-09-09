import { useEffect, useState } from 'react'

// PDFプレビューの「ダウンロード」「共有」ボタン（2026-09-09）。
// 従来は1つの「共有 / 保存」ボタンでWeb Share APIを試し、非対応・失敗時だけ暗黙に
// ダウンロードへフォールバックしていたため、共有シートを開いてもメール等への共有と
// 「端末に保存」の区別が付かず、結局2回操作しないとダウンロードできないと報告された。
// ダウンロードは常にこのボタン1つで完結させ、共有（メール添付等）は対応環境でだけ
// 別ボタンとして独立させる。
function canShareFile(filename) {
  if (typeof navigator === 'undefined' || !navigator.canShare) return false
  try {
    return navigator.canShare({ files: [new File([], filename, { type: 'application/pdf' })] })
  } catch {
    return false
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export default function PdfPreviewActions({ blob, filename }) {
  const [shareable, setShareable] = useState(false)

  useEffect(() => {
    setShareable(canShareFile(filename))
  }, [filename])

  async function handleShare() {
    const file = new File([blob], filename, { type: 'application/pdf' })
    try {
      await navigator.share({ files: [file], title: filename })
    } catch (err) {
      if (err?.name !== 'AbortError') downloadBlob(blob, filename)
    }
  }

  return (
    <div className="attachment-preview-actions">
      <button type="button" className="attachment-preview-download" onClick={() => downloadBlob(blob, filename)}>
        ダウンロード
      </button>
      {shareable && (
        <button type="button" className="attachment-preview-share" onClick={handleShare}>
          共有…
        </button>
      )}
    </div>
  )
}
