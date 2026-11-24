import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import AttendanceSheet from './AttendanceSheet.jsx'
import AttachmentPreview from '../../components/AttachmentPreview.jsx'
import PdfPreviewActions from '../../components/PdfPreviewActions.jsx'
import PdfBusyOverlay from '../../components/PdfBusyOverlay.jsx'
import { api, getToken } from '../lib/api.js'

// 出勤簿 PDF の出力（2026-11-24。タスク管理の帳票 useWasteSheetPdfExport と同じ流れ）
//   データを読む → 画面外に A4 のシートを並べる → 1 枚ずつ html2canvas で撮って jsPDF の 1 ページに →
//   サーバーに一時保存して、タスク管理と同じプレビュー画面（AttachmentPreview：共有・ダウンロード・プリント）で開く。
//   target: スタッフの id（1 人分）または 'proxy'（入力方法が「管理者が代理入力」の全員分）
async function createPreviewUrl(blob, filename) {
  const res = await fetch('/api/works/pdf-preview?kind=attendance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', Authorization: `Bearer ${getToken()}` },
    body: blob,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.token) throw new Error(data.error || `プレビューの準備に失敗しました（${res.status}）`)
  return `/api/works/pdf-preview?${new URLSearchParams({ token: data.token, filename })}`
}

function sheetFilename(month, sheets) {
  const ym = month.replace('-', '')
  if (sheets.length === 1) return `出勤簿_${ym}_${sheets[0].staff.code}_${sheets[0].staff.name.replace(/\s+/g, '')}.pdf`
  return `出勤簿_${ym}_代理入力_${sheets.length}名.pdf`
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

export default function useAttendanceSheetPdf() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(null)
  const [data, setData] = useState(null)
  const sheetRef = useRef(null)

  async function open(month, target) {
    setBusy(true)
    setError('')
    try {
      const d = await api(`/api/works/attendance-sheet?${new URLSearchParams({ month, staff_id: target })}`)
      if (!d.sheets.length) {
        throw new Error(target === 'proxy' ? '入力方法が「管理者が代理入力」のスタッフがいません（スタッフの画面で設定できます）' : 'スタッフが見つかりません')
      }
      setData(d)
      await nextFrame()
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')])
      document.body.classList.add('pdf-capture-mode')
      try {
        await nextFrame()
        const pages = sheetRef.current ? [...sheetRef.current.querySelectorAll('.att-sheet')] : []
        if (pages.length !== d.sheets.length) throw new Error('シートの準備に失敗しました')
        const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
        for (let i = 0; i < pages.length; i++) {
          // 人数が多いとファイルが大きくなるので JPEG にする（保存先の上限 10MB）
          const canvas = await html2canvas(pages[i], { scale: 2.5, backgroundColor: '#ffffff' })
          if (i > 0) pdf.addPage()
          pdf.addImage(canvas.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, 210, 297, undefined, 'FAST')
        }
        const filename = sheetFilename(month, d.sheets)
        const blob = pdf.output('blob')
        setPreview({ filename, blob, url: await createPreviewUrl(blob, filename) })
      } finally {
        document.body.classList.remove('pdf-capture-mode')
      }
    } catch (e) {
      setError(`出勤簿の作成に失敗しました（${e instanceof Error ? e.message : String(e)}）`)
    } finally {
      setBusy(false)
      setData(null)
    }
  }

  const portal = data
    ? createPortal(
        <div ref={sheetRef}>
          {data.sheets.map((s) => (
            <AttendanceSheet key={s.staff.id} month={data.month} sheet={s} holidays={data.holidays} companyHolidays={data.company_holidays} />
          ))}
        </div>,
        document.body,
      )
    : null

  const ui = (
    <>
      {portal}
      {preview && (
        <AttachmentPreview
          attachment={{ filename: preview.filename, mimeType: 'application/pdf' }}
          url={preview.url}
          onClose={() => setPreview(null)}
          headerAction={<PdfPreviewActions blob={preview.blob} filename={preview.filename} />}
        />
      )}
      <PdfBusyOverlay show={busy} label="出勤簿を作成しています…" />
    </>
  )

  return { busy, error, open, ui }
}
