import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import BilmenScheduleSheet from '../components/BilmenScheduleSheet'
import AttachmentPreview from '../components/AttachmentPreview'
import PdfBusyOverlay from '../components/PdfBusyOverlay'
import { getReportPdfPreviewUrl, todayJST } from '../lib/reports'
import { notifyTargets, BILMEN_BUILDING_NAME } from '../lib/bilmen'

// 日程表（1階掲示用）のPDF出力（docs/bilmen-plan.md 8-1）。
// 構成は自主検査表・残留塩素等検査のPDF出力（useInspectionPdfExport.jsx 等）と同じで、
// 画面外に組んだ紙様式のシートを html2canvas で撮り、A4縦1枚のPDFにしてアプリ内で
// プレビュー表示する。呼び出し元（Bilmen.jsx）が既に読み込んでいる当月の予定
// （schedules）と祝日をそのまま渡してもらう形にし、このフック自身は取得を行わない。
export default function useBilmenSchedulePdfExport() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(null)
  const [sheetData, setSheetData] = useState(null)
  const sheetRef = useRef(null)

  async function download(month, schedules, holidays) {
    setBusy(true)
    setError('')
    try {
      const items = notifyTargets(schedules)
      const outputDate = todayJST().replaceAll('-', '/')

      setSheetData({ month, items, holidays, outputDate })
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      if (!sheetRef.current) throw new Error('シートの準備に失敗しました')

      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import('html2canvas'),
        import('jspdf'),
      ])

      document.body.classList.add('pdf-capture-mode')
      try {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const sheet = sheetRef.current.querySelector('.bsch-sheet')
        if (!sheet) throw new Error('シートの準備に失敗しました')

        const canvas = await html2canvas(sheet, { scale: 3, backgroundColor: '#ffffff' })
        const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
        pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, 210, 297, undefined, 'FAST')

        const filename = `日程表_${month}.pdf`
        const pdfBlob = pdf.output('blob')
        const previewUrl = await getReportPdfPreviewUrl(pdfBlob, filename, 'bilmen-schedule')
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

  // Web Share APIが使える環境（主にiOS）ではファイル共有シートを、それ以外では通常のダウンロードにする
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

  const sheetsPortal = sheetData
    ? createPortal(
        <div ref={sheetRef}>
          <BilmenScheduleSheet
            month={sheetData.month}
            buildingName={BILMEN_BUILDING_NAME}
            items={sheetData.items}
            holidays={sheetData.holidays}
            outputDate={sheetData.outputDate}
          />
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
