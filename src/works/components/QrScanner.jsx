// カメラで QR を読む（打刻用）。背面カメラの映像を絶えず読み、写った時点で onResult(text) を呼ぶ（撮影ボタンは不要）。
//   読み取り: 端末の QR 読み取り機能（BarcodeDetector。Android の Chrome など）があればそれを使い、無ければ ZXing。
//   ZXing は 1 コマごとに「中央の正方形」と「画面全体」を交互に読む（近づけても離しても読めるように）。
// カメラが使えない端末・許可されなかったときは「写真を撮って読む」に切り替えられる。
import { useEffect, useRef, useState } from 'react'
import { readQr, readQrFromVideo } from '../lib/qr.js'

export default function QrScanner({ onResult, paused = false }) {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const pausedRef = useRef(paused)
  const [error, setError] = useState('')
  const [live, setLive] = useState(false)
  pausedRef.current = paused

  useEffect(() => {
    let stream
    let timer
    let stopped = false
    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('この端末ではカメラを使えません。下の「写真を撮って読む」をお使いください。')
        return
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        })
        if (stopped) return
        // ピントを合わせ続ける（対応している端末だけ。失敗しても読み取りは続ける）
        const track = stream.getVideoTracks()[0]
        if (track?.getCapabilities?.().focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {})
        const v = videoRef.current
        v.srcObject = stream
        await v.play().catch(() => {})
        setLive(true)
        let detector = null
        try {
          if ('BarcodeDetector' in window && (await window.BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
            detector = new window.BarcodeDetector({ formats: ['qr_code'] })
          }
        } catch {
          detector = null
        }
        let busy = false
        let frame = 0
        const tick = async () => {
          if (stopped || busy || pausedRef.current || !videoRef.current || videoRef.current.readyState < 2) return
          busy = true
          try {
            let text = null
            if (detector) {
              const codes = await detector.detect(videoRef.current).catch(() => [])
              text = codes[0]?.rawValue || null
            }
            if (!text) text = readQrFromVideo(videoRef.current, canvasRef.current, frame++ % 2 === 0 ? 'center' : 'full')
            if (text && !stopped) onResultRef.current(text)
          } finally {
            busy = false
          }
        }
        timer = setInterval(tick, 120)
      } catch {
        setError('カメラを使えませんでした。カメラの利用を許可するか、下の「写真を撮って読む」をお使いください。')
      }
    }
    start()
    return () => {
      stopped = true
      clearInterval(timer)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  const onResultRef = useRef(onResult)
  onResultRef.current = onResult

  const fromPhoto = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
      const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height))
      const w = Math.round(bmp.width * scale)
      const h = Math.round(bmp.height * scale)
      const c = canvasRef.current
      c.width = w
      c.height = h
      const ctx = c.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(bmp, 0, 0, w, h)
      const { data } = ctx.getImageData(0, 0, w, h)
      const luma = new Uint8ClampedArray(w * h)
      for (let i = 0, j = 0; j < luma.length; i += 4, j++) luma[j] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000
      const text = readQr(luma, w, h)
      if (text) onResult(text)
      else setError('写真から QR を読めませんでした。QR が大きく写るように撮り直してください。')
    } catch {
      setError('写真を読み込めませんでした。')
    }
  }

  return (
    <div className="works-scan">
      <div className="works-scan-view">
        <video ref={videoRef} playsInline muted />
        <div className="works-scan-frame" aria-hidden="true" />
      </div>
      <canvas ref={canvasRef} hidden />
      {live && <p className="works-scan-hint">QR を枠に入れると自動で読み取ります（ボタンを押す必要はありません）</p>}
      {error && <p className="works-error">{error}</p>}
      <label className="btn-plain works-scan-photo">
        うまく読めないときは：写真を撮って読む
        <input type="file" accept="image/*" capture="environment" onChange={fromPhoto} hidden />
      </label>
    </div>
  )
}
