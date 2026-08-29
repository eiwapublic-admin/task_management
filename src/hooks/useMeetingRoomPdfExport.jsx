import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import MeetingRoomSheet from '../components/MeetingRoomSheet'
import AttachmentPreview from '../components/AttachmentPreview'
import PdfBusyOverlay from '../components/PdfBusyOverlay'
import { fetchClosedDays, fetchHolidays, getReportPdfPreviewUrl, halfMonthDayRanges } from '../lib/reports'

// 会議室予約表（PDF出力）を日報カレンダー画面から使うためのフック（2026-08-29）。
// 対象の会議室・様式は「備後町コイズミビル５階」1つに固定のため、月だけを引数に取る。
// 作り方は自主検査表のPDF出力（useInspectionPdfExport.jsx）と同じ
// （画面外の紙様式シートをhtml2canvasで撮り、半月＝1ページのPDFにする）。
export default function useMeetingRoomPdfExport(month) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(null)
  const [sheetsData, setSheetsData] = useState(null)
  const sheetsRef = useRef(null)

  async function download() {
    setBusy(true)
    setError('')
    try {
      const [closed, holidays] = await Promise.all([
        fetchClosedDays({ month }),
        fetchHolidays().catch(() => ({})),
      ])
      const ranges = halfMonthDayRanges(month)

      setSheetsData({ closedDays: new Set(closed), holidays, ranges })
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      if (!sheetsRef.current) throw new Error('シートの準備に失敗しました')

      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import('html2canvas'),
        import('jspdf'),
      ])

      document.body.classList.add('pdf-capture-mode')
      try {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

        // 日付・曜日＋18列の時間帯を並べる横に長い表のため、A4横で出力する（2026-08-29）
        const sheets = sheetsRef.current.querySelectorAll('.mr-sheet')
        const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' })
        for (const [i, sheet] of [...sheets].entries()) {
          const canvas = await html2canvas(sheet, { scale: 3, backgroundColor: '#ffffff' })
          if (i > 0) pdf.addPage()
          pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, 297, 210, undefined, 'FAST')
        }

        const filename = `会議室予約表_${month}.pdf`
        const pdfBlob = pdf.output('blob')
        const previewUrl = await getReportPdfPreviewUrl(pdfBlob, filename, 'meeting-room')
        setPreview({ filename, url: previewUrl, blob: pdfBlob })
      } finally {
        document.body.classList.remove('pdf-capture-mode')
      }
    } catch (err) {
      setError(`PDFの作成に失敗しました（${err instanceof Error ? err.message : String(err)}）`)
    } finally {
      setBusy(false)
      setSheetsData(null)
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

  const sheetsPortal = sheetsData
    ? createPortal(
        <div ref={sheetsRef}>
          {sheetsData.ranges.map((range) => (
            <MeetingRoomSheet
              key={range.from}
              month={month}
              range={range}
              closedDays={sheetsData.closedDays}
              holidays={sheetsData.holidays}
            />
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
