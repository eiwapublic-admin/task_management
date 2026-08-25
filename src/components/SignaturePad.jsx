import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'

// 署名入力欄（5-5）。<canvas> + Pointer Events のみで実装し、外部ライブラリは使わない
// （既存の方針＝ゼロ依存を踏襲）。iPad / スマホで指・Apple Pencil で書く運用を想定。
//
// 実装上の注意点（docs/equipment-plan.md 5-5 に列挙済みのものをそのまま反映）:
//  1. touch-action: none を付けないと、書いている最中に画面がスクロールする
//  2. devicePixelRatio を掛けた実サイズで canvas を作り、CSSサイズと分けて持つ（Retinaでぼやけない）
//  3. 線は lineCap/lineJoin = 'round'、lineWidth は固定（筆圧は使わない）
//  4. pointercancel / pointerleave でもストロークを閉じる（iOSで指が枠外に出たとき）
//  5. 保存時は描画範囲を切り出して余白を詰め、長辺600px程度に縮小してPNG化。背景は白で塗る
//     （帳票・PDFに載せたときに黒背景に潜らないように）
const LINE_WIDTH = 2.5
const EXPORT_MAX_EDGE = 600

const SignaturePad = forwardRef(function SignaturePad({ height = 180 }, ref) {
  const canvasRef = useRef(null)
  const drawingRef = useRef(false)
  const hasInkRef = useRef(false)
  const [hasInk, setHasInk] = useState(false)

  // canvas の実ピクセルサイズを、表示サイズ × devicePixelRatio で作る
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = Math.round(rect.width * dpr)
    canvas.height = Math.round(rect.height * dpr)
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, rect.width, rect.height)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = LINE_WIDTH
    ctx.strokeStyle = '#1a1a1a'
  }, [])

  function pointFromEvent(e) {
    const rect = canvasRef.current.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function handlePointerDown(e) {
    e.preventDefault()
    const canvas = canvasRef.current
    canvas.setPointerCapture(e.pointerId)
    drawingRef.current = true
    const { x, y } = pointFromEvent(e)
    const ctx = canvas.getContext('2d')
    ctx.beginPath()
    ctx.moveTo(x, y)
    // ドラッグせず一点だけタップされた場合（pointermoveが1回も発火しない）でも
    // 「押した」こと自体を線として残す。そうしないと押しただけでは何も描かれず
    // hasInkがfalseのまま保存され、記録上は「未署名」として保存されてしまう
    // （2026-08-25。テスト入力時にサインが消えたとの報告を受けて調査・修正）
    ctx.lineTo(x + 0.01, y + 0.01)
    ctx.stroke()
    if (!hasInkRef.current) {
      hasInkRef.current = true
      setHasInk(true)
    }
  }

  function handlePointerMove(e) {
    if (!drawingRef.current) return
    const ctx = canvasRef.current.getContext('2d')
    const { x, y } = pointFromEvent(e)
    ctx.lineTo(x, y)
    ctx.stroke()
    if (!hasInkRef.current) {
      hasInkRef.current = true
      setHasInk(true)
    }
  }

  function endStroke() {
    drawingRef.current = false
  }

  function clear() {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.restore()
    ctx.scale(dpr, dpr)
    hasInkRef.current = false
    setHasInk(false)
  }

  // 描画範囲だけを切り出し、長辺 EXPORT_MAX_EDGE まで縮小した PNG Blob を返す。
  // 何も書かれていなければ null
  async function getBlob() {
    if (!hasInkRef.current) return null
    const canvas = canvasRef.current
    const dpr = window.devicePixelRatio || 1
    const ctx = canvas.getContext('2d')
    const { width, height: h } = canvas
    const img = ctx.getImageData(0, 0, width, h)
    // 白(またはほぼ白)以外のピクセルの外接矩形を求める
    let minX = width, minY = h, maxX = 0, maxY = 0
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const i = (y * width + x) * 4
        const isWhite = img.data[i] > 250 && img.data[i + 1] > 250 && img.data[i + 2] > 250
        if (!isWhite) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    if (maxX < minX || maxY < minY) return null
    const pad = 6 * dpr
    minX = Math.max(0, minX - pad)
    minY = Math.max(0, minY - pad)
    maxX = Math.min(width, maxX + pad)
    maxY = Math.min(h, maxY + pad)
    const cropW = maxX - minX
    const cropH = maxY - minY

    const longEdge = Math.max(cropW, cropH)
    const scale = longEdge > EXPORT_MAX_EDGE ? EXPORT_MAX_EDGE / longEdge : 1
    const outW = Math.max(1, Math.round(cropW * scale))
    const outH = Math.max(1, Math.round(cropH * scale))

    const out = document.createElement('canvas')
    out.width = outW
    out.height = outH
    const outCtx = out.getContext('2d')
    outCtx.fillStyle = '#ffffff'
    outCtx.fillRect(0, 0, outW, outH)
    outCtx.drawImage(canvas, minX, minY, cropW, cropH, 0, 0, outW, outH)

    return new Promise((resolve) => out.toBlob((blob) => resolve(blob), 'image/png'))
  }

  useImperativeHandle(ref, () => ({ clear, getBlob, isEmpty: () => !hasInkRef.current }))

  return (
    <div className="signature-pad">
      <canvas
        ref={canvasRef}
        className="signature-pad-canvas"
        style={{ height, touchAction: 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
        onPointerLeave={endStroke}
      />
      <div className="signature-pad-actions">
        <span className="signature-pad-hint">{hasInk ? '' : 'ここに指またはペンで署名してください'}</span>
        <button type="button" className="btn-plain" onClick={clear} disabled={!hasInk}>
          取消
        </button>
      </div>
    </div>
  )
})

export default SignaturePad
