import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import BilmenNoticeSheet from '../components/BilmenNoticeSheet'
import BilmenNoticeCardSheet from '../components/BilmenNoticeCardSheet'
import AttachmentPreview from '../components/AttachmentPreview'
import PdfPreviewActions from '../components/PdfPreviewActions'
import PdfBusyOverlay from '../components/PdfBusyOverlay'
import { getReportPdfPreviewUrl, todayJST } from '../lib/reports'
import { notifyTargets, BILMEN_BUILDING_NAME, DEFAULT_NOTICE_LAYOUT } from '../lib/bilmen'

// 作業予定連絡票（EV掲示・投函・メール添付用）のPDF出力（docs/bilmen-plan.md 8-2）。
// 件数が多い月は複数ページに分割する（会議室予約表のフックと同じ、画面外シートを
// 複数枚描いて1枚ずつ撮る方式）。呼び出し元（Bilmen.jsx）が既に読み込んでいる
// 当月の予定をそのまま渡してもらう。
//
// ページ割りは固定件数（旧実装は13-12の見込みで5件固定）ではなく、実際の高さを
// 計測してから決める（2026-09-09。添付の実物PDFで、5件目までは大きな余白を残した
// まま6件目が2ページ目へ溢れていることが分かったため）。手順:
//   1. 全件を高さ無制限の「計測用シート」（.is-measuring）に描き、各件の実際の
//      高さと、1ページに使える高さ（.bno-probe の目盛り）を読む
//   2. その実測値をもとに、1ページに収まるだけ詰めてページを組み直す
//   3. 組み直したページ割りで改めて描画し、1ページずつ html2canvas で撮る
// 固定値をmm→pxで自前計算せず全部DOM計測に頼ることで、ブラウザのズーム・DPI設定にも
// 依存しない。
//
// 2026-09-14、レイアウトを2種類から選べるようにした（lib/bilmen.js の NOTICE_LAYOUTS）。
//   standard … 従来版。1件＝1行を縦に積む。長い留意事項が多い月でも崩れない
//   card     … カード版。1件＝1枚のカードを2段組。同じ件数なら縦の消費が約半分
// 載せる情報と報知対象の絞り込みは共通で、違うのは用紙コンポーネントと詰め込み
// 単位だけ（standard は1件ずつ、card はグリッドの1行＝2件ずつ）。
// 版の表示名・既定の記憶は画面側でも使うため lib/bilmen.js にあり、ここが持つのは
// 計測に使うDOMの要素名だけ
const LAYOUT_SELECTORS = {
  standard: { sheet: '.bno-sheet', unit: '.bno-item' },
  card: { sheet: '.bnc-sheet', unit: '.bnc-card' },
}

export default function useBilmenNoticePdfExport() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(null)
  const [sheetData, setSheetData] = useState(null)
  const sheetsRef = useRef(null)

  // 従来版の詰め込み。全件を計測用シートで描いた後の実測値から、1ページに収まるだけ
  // 詰めてページ割りを作る。1件も入っていないページができないよう、ページの先頭の1件だけは
  // 高さを超えても必ず載せる（極端に長い留意事項1件だけでページが埋まる場合の
  // 無限ループ・空ページ防止）
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

  // カード版の詰め込み。2段組なのでページを跨げる最小単位はグリッドの1行（＝2件）で、
  // 行の高さは左右のカードのうち高いほう。行単位で詰めていく以外は従来版と同じ考え方
  function packCardsIntoPages(items, heights, budgetPx, rowGapPx) {
    const rows = []
    for (let i = 0; i < items.length; i += 2) {
      rows.push({
        items: items.slice(i, i + 2),
        startIndex: i,
        height: Math.max(heights[i], heights[i + 1] ?? 0),
      })
    }

    const pages = []
    let current = { items: [], startIndex: 0 }
    let used = 0
    for (const row of rows) {
      // 2行目以降は行間の gap も消費する
      const span = row.height + (current.items.length > 0 ? rowGapPx : 0)
      if (current.items.length > 0 && used + span > budgetPx) {
        pages.push(current)
        current = { items: [...row.items], startIndex: row.startIndex }
        used = row.height
        continue
      }
      current.items.push(...row.items)
      used += span
    }
    if (current.items.length > 0) pages.push(current)
    return pages
  }

  async function download(month, schedules, note, layout = DEFAULT_NOTICE_LAYOUT) {
    const sel = LAYOUT_SELECTORS[layout] || LAYOUT_SELECTORS[DEFAULT_NOTICE_LAYOUT]
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
      setSheetData({ month, layout, mode: 'measure', items, outputDate, note })
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const measureRoot = sheetsRef.current
      const sheetEl = measureRoot?.querySelector(sel.sheet)
      const unitEls = measureRoot ? [...measureRoot.querySelectorAll(sel.unit)] : []
      const probe = measureRoot?.querySelector('.bno-probe')
      if (!sheetEl || !probe || unitEls.length !== items.length) throw new Error('シートの計測に失敗しました')

      const sheetTop = sheetEl.getBoundingClientRect().top
      const totalPx = probe.querySelector('.is-total').getBoundingClientRect().height
      const bottomPaddingPx = probe.querySelector('.is-bottom-padding').getBoundingClientRect().height
      const footerReservePx = probe.querySelector('.is-footer-reserve').getBoundingClientRect().height
      // 1件目の上端（＝シート先頭からヘッダー・見出し・パディング分を差し引いた位置）より
      // 上が「毎ページ必ず消費される」固定分。そこから逆算して各ページの残り高さを求める
      const headingOffsetPx = unitEls[0].getBoundingClientRect().top - sheetTop
      const budgetPx = totalPx - bottomPaddingPx - footerReservePx - headingOffsetPx

      let pages
      if (layout === 'card') {
        const heights = unitEls.map((el) => el.getBoundingClientRect().height)
        const gridEl = measureRoot.querySelector('.bnc-grid')
        const rowGapPx = gridEl ? parseFloat(getComputedStyle(gridEl).rowGap) || 0 : 0
        pages = packCardsIntoPages(items, heights, budgetPx, rowGapPx)
      } else {
        const itemTops = unitEls.map((el) => el.getBoundingClientRect().top - sheetTop)
        const lastBottom = unitEls[unitEls.length - 1].getBoundingClientRect().bottom - sheetTop
        const spans = itemTops.map((top, i) => (i + 1 < itemTops.length ? itemTops[i + 1] : lastBottom) - top)
        pages = packItemsIntoPages(items, spans, budgetPx)
      }

      // --- 2. 実測に基づくページ割りで改めて描画し、1ページずつ撮る ---
      setSheetData({ month, layout, mode: 'print', pages, outputDate, note })
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      if (!sheetsRef.current) throw new Error('シートの準備に失敗しました')

      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import('html2canvas'),
        import('jspdf'),
      ])

      const sheets = sheetsRef.current.querySelectorAll(sel.sheet)
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

  const Sheet = sheetData?.layout === 'card' ? BilmenNoticeCardSheet : BilmenNoticeSheet

  const sheetsPortal = sheetData
    ? createPortal(
        <div ref={sheetsRef}>
          {sheetData.mode === 'measure' ? (
            <>
              {/* 高さ無制限の1枚に全件描き、実際の高さを計測する（ページ割りはまだ決めない） */}
              <Sheet
                month={sheetData.month}
                buildingName={BILMEN_BUILDING_NAME}
                items={sheetData.items}
                startIndex={0}
                outputDate={sheetData.outputDate}
                isLastPage={false}
                note={sheetData.note}
                measuring
              />
              {/* 1ページに使える高さを実測するための目盛り（表示はしない。CSS参照）。
                  用紙の寸法・余白は版によらず同じなので従来版のものを共用する */}
              <div className="bno-probe" aria-hidden="true">
                <div className="is-total" />
                <div className="is-bottom-padding" />
                <div className="is-footer-reserve" />
              </div>
            </>
          ) : (
            sheetData.pages.map((page, i) => (
              <Sheet
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
      headerAction={<PdfPreviewActions blob={preview.blob} filename={preview.filename} />}
    />
  ) : null

  const busyOverlay = <PdfBusyOverlay show={busy} />

  return { busy, error, download, sheetsPortal, previewModal, busyOverlay }
}
