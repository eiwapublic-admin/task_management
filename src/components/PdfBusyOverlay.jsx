// PDF作成中の全画面ブロック（2026-08-10）。
// PDF生成には数秒かかるが、ボタン自体の disabled 属性だけでは他の操作（画面遷移・別のPDF
// ボタン等）を防げず、「押しても反応が無い」ように感じられていた。生成中は他の操作を
// 一切受け付けないようにし、進行中であることが分かるようにする。
export default function PdfBusyOverlay({ show }) {
  if (!show) return null
  return (
    <div className="pdf-busy-overlay" role="status" aria-live="polite">
      <div className="pdf-busy-box">
        <span className="pdf-busy-spinner" aria-hidden="true" />
        PDFを作成しています…
      </div>
    </div>
  )
}
