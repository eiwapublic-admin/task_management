import { useEffect, useRef } from 'react'

// 添付ファイル（画像・PDF）をアプリ内でプレビュー表示するモーダル。
// タスク詳細モーダルの上に重ねて表示する（オーバーレイのz-indexをより高くする）。
export default function AttachmentPreview({ attachment, url, onClose }) {
  const overlayRef = useRef(null)

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  if (!attachment || !url) return null

  const isImage = (attachment.mimeType || '').startsWith('image/')
  const isPdf = attachment.mimeType === 'application/pdf'

  // 背景クリックで閉じる。タスク詳細モーダル自体のオーバーレイにも同じ
  // onClickが付いているため、伝播させると詳細モーダルまで一緒に閉じてしまう。
  function handleOverlayClick(e) {
    e.stopPropagation()
    onClose()
  }

  return (
    <div className="attachment-preview-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div
        className="attachment-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${attachment.filename} のプレビュー`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="attachment-preview-header">
          <span className="attachment-preview-filename">{attachment.filename}</span>
          <button
            className="attachment-preview-close"
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            aria-label="閉じる"
          >
            ×
          </button>
        </div>
        <div className="attachment-preview-body">
          {isImage && <img src={url} alt={attachment.filename} className="attachment-preview-image" />}
          {isPdf && (
            <iframe src={url} title={attachment.filename} className="attachment-preview-pdf" />
          )}
          {!isImage && !isPdf && (
            <p className="attachment-preview-unsupported">このファイル形式はプレビューに対応していません。</p>
          )}
        </div>
      </div>
    </div>
  )
}
