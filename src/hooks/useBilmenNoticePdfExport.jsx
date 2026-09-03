import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import BilmenNoticeSheet from '../components/BilmenNoticeSheet'
import AttachmentPreview from '../components/AttachmentPreview'
import PdfBusyOverlay from '../components/PdfBusyOverlay'
import { getReportPdfPreviewUrl, todayJST } from '../lib/reports'
import { notifyTargets, BILMEN_BUILDING_NAME } from '../lib/bilmen'

// 1ページあたりの掲載件数。留意事項が長い月でも1枚に収まる想定の控えめな件数
// （13-12。実物で溢れる月が見つかったら要調整）
const ITEMS_PER_PAGE = 5

// 作業予定連絡票（EV掲示・投函・メール添付用）のPDF出力（docs/bilmen-plan.md 8-2）。
// 件数が多い月は複数ページに分割する（会議室予約表のフックと同じ、画面外シートを
// 複数枚描いて1枚ずつ撮る方式）。呼び出し元（Bilmen.jsx）が既に読み込んでいる
// 当月の予定をそのまま渡してもらう。
export default function useBilmenNoticePdfExport() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(null)
  const [sheetData, setSheetData] = useState(null)
  const sheetsRef = useRef(null)

  async function download(month, schedules) {
    setBusy(true)
    setError('')
    try {
      const items = notifyTargets(schedules).sort((a, b) => (a.plan_date || '').localeCompare(b.plan_date || ''))
      if (items.length === 0) {
        setError('この月には報知対象（報知☑・予定日付あり・中止でない）の予定がありません')
        return
      }
      const outputDate = todayJST().replaceAll('-', '/')
      const pages = []
      for (let i = 0; i < items.length; i += ITEMS_PER_PAGE) {
        pages.push({ items: items.slice(i, i + ITEMS_PER_PAGE), startIndex: i })
      }

      setSheetData({ month, pages, outputDate })
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      if (!sheetsRef.current) throw new Error('シートの準備に失敗しました')

      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import('html2canvas'),
        import('jspdf'),
      ])

      document.body.classList.add('pdf-capture-mode')
      try {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const sheets = sheetsRef.current.querySelectorAll('.bno-sheet')
        if (sheets.length === 0) throw new Error('シートの準備に失敗しました')

        const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
        for (const [i, sheet] of [...sheets].entries()) {
          const canvas = await html2canvas(sheet, { scale: 3, backgroundColor: '#ffffff' })
          if (i > 0) pdf.addPage()
          pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, 210, 297, undefined, 'FAST')
        }

        const filename = `作業予定連絡票_${month}.pdf`
        const pdfBlob = pdf.output('blob')
        const previewUrl = await getReportPdfPreviewUrl(pdfBlob, filename, 'bilmen-notice')
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
        <div ref={sheetsRef}>
          {sheetData.pages.map((page, i) => (
            <BilmenNoticeSheet
              key={page.startIndex}
              month={sheetData.month}
              buildingName={BILMEN_BUILDING_NAME}
              items={page.items}
              startIndex={page.startIndex}
              outputDate={sheetData.outputDate}
              isLastPage={i === sheetData.pages.length - 1}
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
