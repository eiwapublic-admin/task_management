import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import WasteSheet from '../components/WasteSheet'
import AttachmentPreview from '../components/AttachmentPreview'
import PdfPreviewActions from '../components/PdfPreviewActions'
import PdfBusyOverlay from '../components/PdfBusyOverlay'
import { getReportPdfPreviewUrl } from '../lib/reports'

// 廃棄物実測集計表（記入用の空欄シート）のPDF出力（2026-09-03。依頼元が現行使っている
// 紙シートと同じ様式であらかじめ印刷し、手書きの入力用紙として配布するためのもの。
// 値は一切入れない＝既存データの取得は不要なので、他の帳票フックと違い月と祝日だけ渡す）。
export default function useWasteSheetPdfExport() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(null)
  const [sheetData, setSheetData] = useState(null)
  const sheetRef = useRef(null)

  async function download(month, holidays) {
    setBusy(true)
    setError('')
    try {
      setSheetData({ month, holidays })
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      if (!sheetRef.current) throw new Error('シートの準備に失敗しました')

      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import('html2canvas'),
        import('jspdf'),
      ])

      document.body.classList.add('pdf-capture-mode')
      try {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const sheet = sheetRef.current.querySelector('.waste-sheet')
        if (!sheet) throw new Error('シートの準備に失敗しました')

        const canvas = await html2canvas(sheet, { scale: 3, backgroundColor: '#ffffff' })
        const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
        pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, 210, 297, undefined, 'FAST')

        const filename = `廃棄物実測集計表_${month}.pdf`
        const pdfBlob = pdf.output('blob')
        const previewUrl = await getReportPdfPreviewUrl(pdfBlob, filename, 'waste-sheet')
        setPreview({ filename, url: previewUrl, blob: pdfBlob })
      } finally {
        document.body.classList.remove('pdf-capture-mode')
      }
    } catch (err) {
      setError(`PDFの作成に失敗しました（${err instanceof Error ? err.message : String(err)}）`)
    } finally {
      setBusy(false)
      setSheetData(null)
    }
  }

  const sheetsPortal = sheetData
    ? createPortal(
        <div ref={sheetRef}>
          <WasteSheet month={sheetData.month} holidays={sheetData.holidays} />
        </div>,
        document.body,
      )
    : null

  const previewModal = preview ? (
    <AttachmentPreview
      attachment={{ filename: preview.filename, mimeType: 'application/pdf' }}
      url={preview.url}
      onClose={() => setPreview(null)}
      headerAction={<PdfPreviewActions blob={preview.blob} filename={preview.filename} />}
    />
  ) : null

  const busyOverlay = <PdfBusyOverlay show={busy} />

  return { busy, error, download, sheetsPortal, previewModal, busyOverlay }
}
