import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import BilmenNoticeSheet from '../components/BilmenNoticeSheet'
import AttachmentPreview from '../components/AttachmentPreview'
import PdfBusyOverlay from '../components/PdfBusyOverlay'
import { getReportPdfPreviewUrl, todayJST } from '../lib/reports'
import { notifyTargets, BILMEN_BUILDING_NAME } from '../lib/bilmen'

// 作業予定連絡票（EV掲示・投函・メール添付用）のPDF出力（docs/bilmen-plan.md 8-2）。
// 件数が多い月は複数ページに分割する（会議室予約表のフックと同じ、画面外シートを
// 複数枚描いて1枚ずつ撮る方式）。呼び出し元（Bilmen.jsx）が既に読み込んでいる
// 当月の予定をそのまま渡してもらう。
//
// ページ割りは固定件数（旧実装は13-12の見込みで5件固定）ではなく、実際の高さを
// 計測してから決める（2026-09-09。添付の実物PDFで、5件目までは大きな余白を残した
// まま6件目が2ページ目へ溢れていることが分かったため）。手順:
//   1. 全件を高さ無制限の「計測用シート」（.is-measuring）に描き、各 .bno-item の
//      実際の高さと、1ページに使える高さ（.bno-probe の目盛り）を読む
//   2. その実測値をもとに、1ページに収まるだけ詰めてページを組み直す
//   3. 組み直したページ割りで改めて描画し、1ページずつ html2canvas で撮る
// 固定値をmm→pxで自前計算せず全部DOM計測に頼ることで、ブラウザのズーム・DPI設定にも
// 依存しない。
export default function useBilmenNoticePdfExport() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(null)
  const [sheetData, setSheetData] = useState(null)
  const sheetsRef = useRef(null)

  // 全件を計測用シートで描いた後の実測値から、1ページに収まるだけ詰めてページ割りを作る。
  // 1件も入っていないページができないよう、ページの先頭の1件だけは高さを超えても必ず載せる
  // （極端に長い留意事項1件だけでページが埋まる場合の無限ループ・空ページ防止）
  function packItemsIntoPages(items, spans, budgetPx) {
    const pages = []
    let current = { items: [], startIndex: 0 }
    let used = 0
    items.forEach((item, i) => {
      const span = spans[i]
      if (current.items.length > 0 && used + span > budgetPx) {
        pages.push(current)
        current = { items: [], startIndex: i }
        used = 0
      }
      current.items.push(item)
      used += span
    })
    if (current.items.length > 0) pages.push(current)
    return pages
  }

  async function download(month, schedules, note) {
    setBusy(true)
    setError('')
    document.body.classList.add('pdf-capture-mode')
    try {
      const items = notifyTargets(schedules).sort((a, b) => (a.plan_date || '').localeCompare(b.plan_date || ''))
      if (items.length === 0) {
        setError('この月には報知対象（報知☑・予定日付あり・中止でない）の予定がありません')
        return
      }
      const outputDate = todayJST().replaceAll('-', '/')

      // --- 1. 計測用シート（高さ無制限・全件。今月の注釈があれば見出し直下に含める）を
      //     描き、実際の高さを読む。注釈は1ページ目にしか出さないが、全ページに同じ
      //     （注釈込みの）budgetPxを使う簡略化のため、ここで一緒に測っておく ---
      setSheetData({ month, mode: 'measure', items, outputDate, note })
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const measureRoot = sheetsRef.current
      const sheetEl = measureRoot?.querySelector('.bno-sheet')
      const itemEls = measureRoot ? [...measureRoot.querySelectorAll('.bno-item')] : []
      const probe = measureRoot?.querySelector('.bno-probe')
      if (!sheetEl || !probe || itemEls.length !== items.length) throw new Error('シートの計測に失敗しました')

      const sheetTop = sheetEl.getBoundingClientRect().top
      const totalPx = probe.querySelector('.is-total').getBoundingClientRect().height
      const bottomPaddingPx = probe.querySelector('.is-bottom-padding').getBoundingClientRect().height
      const footerReservePx = probe.querySelector('.is-footer-reserve').getBoundingClientRect().height
      // 1件目の上端（＝シート先頭からヘッダー・見出し・パディング分を差し引いた位置）より
      // 上が「毎ページ必ず消費される」固定分。そこから逆算して各ページの残り高さを求める
      const headingOffsetPx = itemEls[0].getBoundingClientRect().top - sheetTop
      const budgetPx = totalPx - bottomPaddingPx - footerReservePx - headingOffsetPx

      const itemTops = itemEls.map((el) => el.getBoundingClientRect().top - sheetTop)
      const lastBottom = itemEls[itemEls.length - 1].getBoundingClientRect().bottom - sheetTop
      const spans = itemTops.map((top, i) => (i + 1 < itemTops.length ? itemTops[i + 1] : lastBottom) - top)

      const pages = packItemsIntoPages(items, spans, budgetPx)

      // --- 2. 実測に基づくページ割りで改めて描画し、1ページずつ撮る ---
      setSheetData({ month, mode: 'print', pages, outputDate, note })
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      if (!sheetsRef.current) throw new Error('シートの準備に失敗しました')

      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import('html2canvas'),
        import('jspdf'),
      ])

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
    } catch (err) {
      setError(`PDFの作成に失敗しました（${err instanceof Error ? err.message : String(err)}）`)
    } finally {
      document.body.classList.remove('pdf-capture-mode')
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
          {sheetData.mode === 'measure' ? (
            <>
              {/* 高さ無制限の1枚に全件描き、実際の高さを計測する（ページ割りはまだ決めない） */}
              <BilmenNoticeSheet
                month={sheetData.month}
                buildingName={BILMEN_BUILDING_NAME}
                items={sheetData.items}
                startIndex={0}
                outputDate={sheetData.outputDate}
                isLastPage={false}
                note={sheetData.note}
                measuring
              />
              {/* 1ページに使える高さを実測するための目盛り（表示はしない。CSS参照） */}
              <div className="bno-probe" aria-hidden="true">
                <div className="is-total" />
                <div className="is-bottom-padding" />
                <div className="is-footer-reserve" />
              </div>
            </>
          ) : (
            sheetData.pages.map((page, i) => (
              <BilmenNoticeSheet
                key={page.startIndex}
                month={sheetData.month}
                buildingName={BILMEN_BUILDING_NAME}
                items={page.items}
                startIndex={page.startIndex}
                outputDate={sheetData.outputDate}
                isLastPage={i === sheetData.pages.length - 1}
                note={sheetData.note}
              />
            ))
          )}
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
