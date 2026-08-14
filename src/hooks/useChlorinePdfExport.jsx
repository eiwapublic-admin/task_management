import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ChlorineSheet, { CHLORINE_SHEET_ROWS } from '../components/ChlorineSheet'
import AttachmentPreview from '../components/AttachmentPreview'
import PdfBusyOverlay from '../components/PdfBusyOverlay'
import { fetchChlorineTests, getReportPdfPreviewUrl } from '../lib/reports'

// 残留塩素等検査実施記録表（年・測定施設ごと）のPDF出力（2026-08-10）。
// 作りは自主検査表の useInspectionPdfExport と同じで、画面外に組んだ紙様式のシートを
// html2canvas で撮り、1枚＝1ページのPDFにしてアプリ内でプレビュー表示する。
//
// 対象年・対象施設は download(year, building) の呼び出し時に渡す（2026-08-13。
// 以前はフックの呼び出し時に固定していたが、一覧の年別絞り込みを廃止し、年月グループの
// 見出しごとに「↓」を置いて対象年を暗黙に決める構成に変えたため、呼び出し側の状態に
// 依存しない形にした）。戻り値の sheetsPortal / previewModal は呼び出し元のJSXにそのまま差し込む。
export default function useChlorinePdfExport() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // アプリ内プレビュー表示中のPDF（{ filename, url, blob }）。null なら非表示
  const [preview, setPreview] = useState(null)
  // ダウンロード実行中だけ埋める、紙様式シートの描画に必要なページ配列
  const [pages, setPages] = useState(null)
  // ダウンロード実行中の対象年・対象施設（シートの描画に必要）
  const [reportMeta, setReportMeta] = useState(null)
  const sheetsRef = useRef(null)

  // month はヘッダの年月表示専用（対象データは従来どおり年単位で取得する。2026-08-14）
  async function download(year, building, month) {
    setBusy(true)
    setError('')
    try {
      const tests = await fetchChlorineTests({ year, building })
      if (tests.length === 0) {
        setError(`${year}年の${building}の測定記録がありません。`)
        return
      }
      setReportMeta({ year, building, month })
      // 帳票は古い順（実施した順）に並べる。一覧APIは新しい順で返すため入れ替える
      const sorted = [...tests].sort((a, b) => new Date(a.tested_at) - new Date(b.tested_at))
      const sliced = []
      for (let i = 0; i < sorted.length; i += CHLORINE_SHEET_ROWS) {
        sliced.push(sorted.slice(i, i + CHLORINE_SHEET_ROWS))
      }

      // シートをまず描画させる（portal経由でDOMに反映されるのを待つ）
      setPages(sliced)
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      if (!sheetsRef.current) throw new Error('シートの準備に失敗しました')

      // 手書きCSS（hex色・mm指定）のみのシートなので html2canvas-pro ではなく本家を使う
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import('html2canvas'),
        import('jspdf'),
      ])

      document.body.classList.add('pdf-capture-mode')
      try {
        // クラス適用後のレイアウトが確定してから撮る
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

        const sheets = sheetsRef.current.querySelectorAll('.chl-sheet')
        const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
        for (const [i, sheet] of [...sheets].entries()) {
          const canvas = await html2canvas(sheet, { scale: 3, backgroundColor: '#ffffff' })
          if (i > 0) pdf.addPage()
          // 第8引数の圧縮指定（'FAST'）は必須。既定の無圧縮だとA4・scale3の画像が
          // 生データのまま埋め込まれ、数十MBになる（自主検査表PDFと同じ理由）
          pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, 210, 297, undefined, 'FAST')
        }

        const filename = `残留塩素等検査実施記録表_${building}_${year}.pdf`
        // iOSのホーム画面アプリ（standalone）では pdf.save() の download 属性が無視され
        // 画面が真っ白になるため、実URLへの<iframe>ナビゲーションでアプリ内に表示する
        // （プロジェクトスキル print-and-pdf-download Gotcha 8。自主検査表PDFと同じ方式）
        const pdfBlob = pdf.output('blob')
        const previewUrl = await getReportPdfPreviewUrl(pdfBlob, filename, 'chlorine')
        setPreview({ filename, url: previewUrl, blob: pdfBlob })
      } finally {
        // ここを外し忘れるとシートが画面外に出たままになるため必ず finally で戻す
        document.body.classList.remove('pdf-capture-mode')
      }
    } catch (err) {
      // 失敗の原因（描画できない色・レイアウト等）はこのメッセージにしか出ないため握り潰さない
      setError(`PDFの作成に失敗しました（${err instanceof Error ? err.message : String(err)}）`)
    } finally {
      setBusy(false)
      setPages(null) // 撮り終えたらシートは不要（次回の download() でまた組み直す）
    }
  }

  // プレビュー内の「共有 / 保存」。ユーザーが明示的にタップしたときだけ実行する
  // （Web Share APIが使える環境ではファイル共有シート、それ以外は通常のダウンロード）
  async function sharePdf({ blob, filename }) {
    const file = new File([blob], filename, { type: 'application/pdf' })
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename })
        return
      } catch (shareErr) {
        if (shareErr?.name === 'AbortError') return
        // それ以外の失敗時は下の通常ダウンロードにフォールバックする
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

  // PDF用の紙様式シート。通常は何も無く、ダウンロード実行中だけ画面外に描画される。
  // 親のレイアウト（flex/overflow）の影響を受けないよう body 直下に出す。
  const sheetsPortal =
    pages && reportMeta
      ? createPortal(
          <div ref={sheetsRef}>
            {pages.map((rows, i) => (
              <ChlorineSheet
                key={i}
                building={reportMeta.building}
                year={reportMeta.year}
                month={reportMeta.month}
                rows={rows}
                pageIndex={i}
                pageCount={pages.length}
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
