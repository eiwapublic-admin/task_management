import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import MeterPhotoSheet, { METER_PHOTOS_PER_PAGE } from '../components/MeterPhotoSheet'
import AttachmentPreview from '../components/AttachmentPreview'
import PdfPreviewActions from '../components/PdfPreviewActions'
import PdfBusyOverlay from '../components/PdfBusyOverlay'
import { fetchMeterPhotoBlob } from '../lib/meter'
import { getReportPdfPreviewUrl } from '../lib/reports'

// 写真の読み込みが終わってから撮る（終わる前に撮ると空白になる）
function waitForImages(root) {
  const pending = [...root.querySelectorAll('img')].filter((img) => !img.complete)
  return Promise.all(
    pending.map(
      (img) =>
        new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true })
          img.addEventListener('error', resolve, { once: true })
        })
    )
  )
}

// 検針写真一覧のPDF（2026-10-20〜。FileMaker の「メータ写真の印刷」）。写真は2年で消すので、
// 月ごとにこのPDFを保存しておけば後から見返せる（docs/meter-plan.md 10章）。
// 作りは残留塩素の記録表（useChlorinePdfExport）と同じで、画面外に組んだシートを撮って1枚＝1ページにする
export default function useMeterPhotoPdfExport() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(null)
  const [sheet, setSheet] = useState(null) // { month, pages: [[{row, url}]] }
  const sheetsRef = useRef(null)

  async function download(month, rows) {
    setBusy(true)
    setError('')
    const urls = []
    try {
      const items = await Promise.all(
        rows.map(async (row) => {
          if (!row.photo) return { row, url: null }
          const url = URL.createObjectURL(await fetchMeterPhotoBlob(row.photo.id))
          urls.push(url)
          return { row, url }
        })
      )
      const pages = []
      for (let i = 0; i < items.length; i += METER_PHOTOS_PER_PAGE) pages.push(items.slice(i, i + METER_PHOTOS_PER_PAGE))
      setSheet({ month, pages })
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      if (!sheetsRef.current) throw new Error('シートの準備に失敗しました')

      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')])
      document.body.classList.add('pdf-capture-mode')
      try {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        await waitForImages(sheetsRef.current)
        const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
        for (const [i, el] of [...sheetsRef.current.querySelectorAll('.mps-sheet')].entries()) {
          // 写真が主なので JPEG で埋め込む（PNG だと数十MBになる）
          const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff' })
          if (i > 0) pdf.addPage()
          pdf.addImage(canvas.toDataURL('image/jpeg', 0.85), 'JPEG', 0, 0, 210, 297, undefined, 'FAST')
        }
        const [y, m] = month.split('-')
        const filename = `検針写真_${y}年${m}月分.pdf`
        const blob = pdf.output('blob')
        // iOS のホーム画面アプリでも開けるよう、実URLの iframe でアプリ内に表示する（他のPDFと同じ）
        const url = await getReportPdfPreviewUrl(blob, filename, 'meter-photos')
        setPreview({ filename, url, blob })
      } finally {
        document.body.classList.remove('pdf-capture-mode')
      }
    } catch (err) {
      setError(`PDFの作成に失敗しました（${err instanceof Error ? err.message : String(err)}）`)
    } finally {
      setBusy(false)
      setSheet(null)
      for (const u of urls) URL.revokeObjectURL(u)
    }
  }

  const sheetsPortal = sheet
    ? createPortal(
        <div ref={sheetsRef}>
          {sheet.pages.map((items, i) => (
            <MeterPhotoSheet key={i} month={sheet.month} items={items} pageIndex={i} pageCount={sheet.pages.length} />
          ))}
        </div>,
        document.body
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

  return { busy, error, download, sheetsPortal, previewModal, busyOverlay: <PdfBusyOverlay show={busy} /> }
}
