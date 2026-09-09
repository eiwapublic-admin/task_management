// 処理中の全画面ブロック（2026-08-10。2026-09-09にPDF専用から汎用化）。
// 生成・取込等には数秒かかるが、ボタン自体の disabled 属性だけでは他の操作（画面遷移・別の
// ボタン等）を防げず、「押しても反応が無い」ように感じられていた。処理中は他の操作を
// 一切受け付けないようにし、進行中であることが分かるようにする。PDF出力フック以外にも
// 廃棄物のExcel取込など、時間のかかる処理から共通で使う（`label` 省略時は従来どおりPDF向け文言）。
export default function PdfBusyOverlay({ show, label = 'PDFを作成しています…' }) {
  if (!show) return null
  return (
    <div className="pdf-busy-overlay" role="status" aria-live="polite">
      <div className="pdf-busy-box">
        <span className="pdf-busy-spinner" aria-hidden="true" />
        {label}
      </div>
    </div>
  )
}
