import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import InspectionSheet from '../components/InspectionSheet'
import AttachmentPreview from '../components/AttachmentPreview'
import {
  fetchInspections,
  fetchClosedDays,
  fetchHolidays,
  getReportPdfPreviewUrl,
  daysInMonth,
  halfMonthRanges,
} from '../lib/reports'

// 自主検査表（日常）のPDF出力を、呼び出し元のページ（自主検査表画面・日報一覧の
// 両方）から共通で使えるようにしたフック（2026-08-07。元は Inspections.jsx に
// 直接書かれていたものを切り出した）。
//
// 呼び出し元が既に読み込んでいるデータ（一覧の月別状況など）には依存させず、
// download() が呼ばれた時点でこのフック自身が対象月の実施記録・休館日・祝日を
// 取得する。ページを開いた時点では何も取得しないため、PDFを使わないページ
// （日報一覧）の通常表示を重くしない。
//
// 戻り値の sheetsPortal（画面外の紙様式シート）・previewModal（アプリ内プレビュー）は
// 呼び出し元のJSXにそのまま差し込むだけでよい。ボタンの見た目・文言は
// 呼び出し元が自由に作れるよう、busy/error/download だけを露出する。
export default function useInspectionPdfExport(month, building) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // アプリ内プレビュー表示中のPDF（{ filename, url, blob }）。null なら非表示
  const [preview, setPreview] = useState(null)
  // ダウンロード実行中だけ埋める、紙様式シートの描画に必要なデータ一式
  const [sheetsData, setSheetsData] = useState(null)
  const sheetsRef = useRef(null)

  // 画面外に置いた紙様式のシートを html2canvas で撮り、1枚＝1ページのPDFにする。
  // シートは 210×297mm ちょうどで組んであるので addImage の固定配置で必ず1ページに収まる
  // （プロジェクトスキル print-and-pdf-download を参照。iOSのホーム画面アプリでは
  // window.print() が無反応のため、印刷ではなくPDFダウンロードで出力する）。
  async function download() {
    setBusy(true)
    setError('')
    try {
      const [inspections, closed, holidays] = await Promise.all([
        fetchInspections({ month }),
        fetchClosedDays({ month }),
        fetchHolidays().catch(() => ({})),
      ])
      const byDate = new Map()
      for (const r of inspections) {
        if (r.building === building) byDate.set(r.inspected_on, r)
      }
      // 定期点検（6月・12月）と防火管理者確認は月に1つの欄しかないため、その月の記録から拾う
      const monthRecords = inspections.filter((r) => r.building === building)
      const periodicResult = monthRecords.find((r) => r.periodic_result)?.periodic_result || ''
      const confirmedBy = monthRecords.find((r) => r.confirmed_by)?.confirmed_by || ''
      // 紙の様式は「実施日時」が16列しかないため、半月ごとに1ページとする
      const ranges = halfMonthRanges(month, daysInMonth(month))

      // シートをまず描画させる（portal経由でDOMに反映されるのを待つ）
      setSheetsData({ byDate, closedDays: new Set(closed), holidays, periodicResult, confirmedBy, ranges })
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

        const sheets = sheetsRef.current.querySelectorAll('.ins-sheet')
        const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
        for (const [i, sheet] of [...sheets].entries()) {
          const canvas = await html2canvas(sheet, { scale: 3, backgroundColor: '#ffffff' })
          if (i > 0) pdf.addPage()
          // 第8引数の圧縮指定（'FAST'）は必須。既定の無圧縮だとA4・scale3の画像が
          // 生データのまま埋め込まれ、2ページで約48MBになる（'FAST'で約0.9MB。
          // 可逆圧縮なので線や文字の劣化はない）。
          pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, 210, 297, undefined, 'FAST')
        }

        const filename = `自主検査表_${building}_${month}.pdf`
        // pdf.save() は内部で <a download> をクリックして保存させるが、iOS Safari
        // （特にホーム画面アプリのstandalone表示）はdownload属性を無視してblob URLへ
        // そのままナビゲートする。standaloneにはタブの概念が無いため、開いたPDF
        // ビューアの「×」で戻ろうとしてもアプリの画面に復帰できず真っ白になる
        // （2026-08-07に実機で確認）。共有シートを自動で出すのではなく、既存の
        // 添付ファイルプレビューと同じ「実URLへの<iframe>ナビゲーション」方式で
        // アプリ内にプレビュー表示し、×で閉じても画面遷移が無いので復帰できるようにする
        // （プロジェクトスキル print-and-pdf-download Gotcha 8）。
        const pdfBlob = pdf.output('blob')
        const previewUrl = await getReportPdfPreviewUrl(pdfBlob, filename)
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
      setSheetsData(null) // 撮り終えたらシートは不要（次回のdownload()でまた組み直す）
    }
  }

  // プレビュー内の「共有 / 保存」。ユーザーが明示的にタップしたときだけ実行する
  // （自動で共有シートを出すと2026-08-07に報告されたPDF閉じた後の白画面と紛らわしいため）。
  // Web Share APIが使える環境（主にiOS）ではファイル共有シートを、それ以外
  // （デスクトップ等）では通常のダウンロードとして保存する。
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
  const sheetsPortal = sheetsData
    ? createPortal(
        <div ref={sheetsRef}>
          {sheetsData.ranges.map((range) => (
            <InspectionSheet
              key={range.from}
              building={building}
              month={month}
              range={range}
              byDate={sheetsData.byDate}
              closedDays={sheetsData.closedDays}
              holidays={sheetsData.holidays}
              periodicResult={sheetsData.periodicResult}
              confirmedBy={sheetsData.confirmedBy}
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

  return { busy, error, download, sheetsPortal, previewModal }
}
