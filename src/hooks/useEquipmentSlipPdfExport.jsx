import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import EquipmentSlipSheet from '../components/EquipmentSlipSheet'
import AttachmentPreview from '../components/AttachmentPreview'
import PdfBusyOverlay from '../components/PdfBusyOverlay'
import { fetchEquipmentSignatureObjectUrl } from '../lib/equipment'
import { getReportPdfPreviewUrl } from '../lib/reports'

// 修理伝票PDF出力（2026-08-26）。備品：年月順表示の月グループから「テナント設置分」の
// 入出庫明細だけを渡すと、旧FileMaker帳票を模したPDF（A4縦・1枚に2件）を作る。
// 構成は自主検査表・残留塩素等検査のPDF出力（useInspectionPdfExport.jsx等）と同じ
// パターン（sheetsPortal/previewModal/busyOverlay を呼び出し元にそのまま差し込む）。
export default function useEquipmentSlipPdfExport() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(null)
  // ダウンロード実行中だけ埋める、シート描画用のペア配列（[rec, rec|null][]）
  const [pairs, setPairs] = useState(null)
  const sheetsRef = useRef(null)

  // records: [{ id, occurredAt, floor, tenantName, productCode, quantity, staffName,
  //             hasSignature }]（呼び出し元で reason==='tenant' に絞り込み・日付降順に
  // 並べ替え済みのものを渡す）。monthLabel はファイル名に使う表示用の年月（例: '2026年8月'）
  async function download(records, monthLabel) {
    if (!records || records.length === 0) return
    setBusy(true)
    setError('')
    const signatureUrls = []
    try {
      // 署名済みの明細だけ、認証付きで画像を取得しておく（<img src>に直接APIパスは
      // 指定できないため。src/components/EquipmentOutForm.jsx と同じ方式）
      const slipRecords = await Promise.all(
        records.map(async (r) => {
          let signatureUrl = null
          if (r.hasSignature) {
            try {
              signatureUrl = await fetchEquipmentSignatureObjectUrl(r.id)
              signatureUrls.push(signatureUrl)
            } catch {
              signatureUrl = null // 取得できなくても伝票自体は出す（受領印欄が空になるだけ）
            }
          }
          return { ...r, signatureUrl }
        })
      )

      // 1ページ=2件。奇数件なら最後のページの2件目を空欄（null）にする
      const chunked = []
      for (let i = 0; i < slipRecords.length; i += 2) {
        chunked.push([slipRecords[i], slipRecords[i + 1] || null])
      }

      setPairs(chunked)
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      if (!sheetsRef.current) throw new Error('シートの準備に失敗しました')

      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import('html2canvas'),
        import('jspdf'),
      ])

      document.body.classList.add('pdf-capture-mode')
      try {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

        const sheets = sheetsRef.current.querySelectorAll('.equip-slip-sheet')
        const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
        for (const [i, sheet] of [...sheets].entries()) {
          const canvas = await html2canvas(sheet, { scale: 3, backgroundColor: '#ffffff' })
          if (i > 0) pdf.addPage()
          pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, 210, 297, undefined, 'FAST')
        }

        const filename = `修理伝票_${monthLabel}.pdf`
        const pdfBlob = pdf.output('blob')
        // iOSのstandalone表示でのdownload属性無視対策として、アプリ内プレビュー
        // （<iframe>ナビゲーション方式）で開く（自主検査表PDFと同じ。
        // プロジェクトスキル print-and-pdf-download Gotcha 8）
        const previewUrl = await getReportPdfPreviewUrl(pdfBlob, filename, 'equipment')
        setPreview({ filename, url: previewUrl, blob: pdfBlob })
      } finally {
        document.body.classList.remove('pdf-capture-mode')
      }
    } catch (err) {
      setError(`PDFの作成に失敗しました（${err instanceof Error ? err.message : String(err)}）`)
    } finally {
      setBusy(false)
      setPairs(null)
      for (const url of signatureUrls) URL.revokeObjectURL(url)
    }
  }

  async function sharePdf({ blob, filename }) {
    const file = new File([blob], filename, { type: 'application/pdf' })
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename })
        return
      } catch (shareErr) {
        if (shareErr?.name === 'AbortError') return
      }
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const sheetsPortal = pairs
    ? createPortal(
        <div ref={sheetsRef}>
          {pairs.map((pair, i) => (
            <EquipmentSlipSheet key={pair[0]?.id || i} pair={pair} />
          ))}
        </div>,
        document.body,
      )
    : null

  const previewModal = preview ? (
    <AttachmentPreview
      attachment={{ filename: preview.filename, mimeType: 'application/pdf' }}
      url={preview.url}
      onClose={() => setPreview(null)}
      headerAction={
        <button type="button" className="attachment-preview-share" onClick={() => sharePdf(preview)}>
          共有 / 保存
        </button>
      }
    />
  ) : null

  const busyOverlay = <PdfBusyOverlay show={busy} />

  return { busy, error, download, sheetsPortal, previewModal, busyOverlay }
}
