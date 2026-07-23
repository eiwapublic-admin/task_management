import { useEffect, useRef, useState } from 'react'

const MIN_SCALE = 1
const MAX_SCALE = 5
const WHEEL_ZOOM_FACTOR = 1.15

function clampScale(s) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
}

function touchDistance(touches) {
  const [a, b] = touches
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

// 添付ファイル（画像・PDF）をアプリ内でプレビュー表示するモーダル。
// タスク詳細モーダルの上に重ねて表示する（オーバーレイのz-indexをより高くする）。
// 画像はホイール/ピンチでの拡大縮小・ドラッグでの移動に対応する
// （PDFはブラウザ内蔵のPDFビューア自体がズーム機能を持つため、ここでは制御しない）。
export default function AttachmentPreview({ attachment, url, onClose }) {
  const overlayRef = useRef(null)
  const dragRef = useRef(null)
  const pinchRef = useRef(null)

  const [scale, setScale] = useState(1)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  // 表示対象が変わったらズーム・位置をリセットする
  useEffect(() => {
    setScale(1)
    setPos({ x: 0, y: 0 })
  }, [attachment, url])

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

  function zoomBy(factor) {
    setScale((s) => {
      const next = clampScale(s * factor)
      if (next === 1) setPos({ x: 0, y: 0 })
      return next
    })
  }

  function resetZoom() {
    setScale(1)
    setPos({ x: 0, y: 0 })
  }

  function handleWheel(e) {
    if (!isImage) return
    e.preventDefault()
    zoomBy(e.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR)
  }

  function handleDoubleClick() {
    if (!isImage) return
    if (scale > 1) resetZoom()
    else setScale(2)
  }

  // マウス/1本指ドラッグでの移動（拡大時のみ）
  function handlePointerDown(e) {
    if (!isImage || scale <= 1) return
    dragRef.current = { startX: e.clientX, startY: e.clientY, startPosX: pos.x, startPosY: pos.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function handlePointerMove(e) {
    if (!dragRef.current) return
    const dx = e.clientX - dragRef.current.startX
    const dy = e.clientY - dragRef.current.startY
    setPos({ x: dragRef.current.startPosX + dx, y: dragRef.current.startPosY + dy })
  }
  function handlePointerUp() {
    dragRef.current = null
  }

  // 2本指ピンチでの拡大縮小（触れている指が2本の間だけ処理し、
  // 1本指のドラッグ移動とはPointer Eventsの方で棲み分ける）
  function handleTouchStart(e) {
    if (e.touches.length === 2) {
      pinchRef.current = { startDist: touchDistance(e.touches), startScale: scale }
    }
  }
  function handleTouchMove(e) {
    if (e.touches.length === 2 && pinchRef.current) {
      const dist = touchDistance(e.touches)
      const ratio = dist / pinchRef.current.startDist
      const next = clampScale(pinchRef.current.startScale * ratio)
      setScale(next)
      if (next === 1) setPos({ x: 0, y: 0 })
    }
  }
  function handleTouchEnd(e) {
    if (e.touches.length < 2) pinchRef.current = null
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
          {isImage && (
            <div className="attachment-preview-zoom-controls">
              <button type="button" onClick={() => zoomBy(1 / WHEEL_ZOOM_FACTOR)} aria-label="縮小">
                −
              </button>
              <span className="attachment-preview-zoom-level">{Math.round(scale * 100)}%</span>
              <button type="button" onClick={() => zoomBy(WHEEL_ZOOM_FACTOR)} aria-label="拡大">
                ＋
              </button>
              {scale !== 1 && (
                <button type="button" onClick={resetZoom} aria-label="ズームをリセット">
                  リセット
                </button>
              )}
            </div>
          )}
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
        <div className="attachment-preview-body" onWheel={handleWheel}>
          {isImage && (
            <img
              src={url}
              alt={attachment.filename}
              className="attachment-preview-image"
              style={{
                transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
                cursor: scale > 1 ? 'grab' : 'zoom-in',
              }}
              draggable={false}
              onDoubleClick={handleDoubleClick}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={handlePointerUp}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
            />
          )}
          {isPdf && <iframe src={url} title={attachment.filename} className="attachment-preview-pdf" />}
          {!isImage && !isPdf && (
            <p className="attachment-preview-unsupported">このファイル形式はプレビューに対応していません。</p>
          )}
        </div>
      </div>
    </div>
  )
}
