// 現場の QR の掲示物（A4 縦。出勤用・退勤用の 2 枚。docs/eworks-plan.md 6-1）。
// 発行（再発行）した直後にだけ表示できる（合言葉はハッシュしか保存しないため、印刷し直すときは再発行する）。
// PDF は画面外に置いた A4 のシートを html2canvas で撮って jsPDF に載せる（.claude/skills/print-and-pdf-download。
// このシートは手書きの CSS・16 進の色だけなので、通常の html2canvas で撮れる）
import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Modal from './Modal.jsx'
import { punchUrl, qrDataUrl } from '../lib/qr.js'

const KINDS = [
  { k: 'in', label: '出勤', color: '#1f8a4c', note: '仕事を始めるときに読み取ってください' },
  { k: 'out', label: '退勤', color: '#d4691a', note: '仕事を終えるときに読み取ってください' },
]

export default function QrSheet({ site, token, onClose }) {
  const sheetsRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const issued = new Date(site.qr_issued_at || Date.now()).toLocaleDateString('ja-JP')
  const qrs = useMemo(
    () => Object.fromEntries(KINDS.map(({ k }) => [k, qrDataUrl(punchUrl(window.location.origin, site.code, k, token), 900)])),
    [site.code, token]
  )

  const download = async () => {
    setBusy(true)
    setError('')
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')])
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
      const sheets = sheetsRef.current.querySelectorAll('.works-qr-sheet')
      for (let i = 0; i < sheets.length; i++) {
        const canvas = await html2canvas(sheets[i], { scale: 2, backgroundColor: '#ffffff' })
        if (i > 0) pdf.addPage()
        const h = (canvas.height / canvas.width) * 210
        pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, 210, Math.min(h, 297), undefined, 'FAST')
      }
      pdf.save(`QR_${site.code}_${site.name}.pdf`)
    } catch (e) {
      setError(`PDF の作成に失敗しました（${e instanceof Error ? e.message : String(e)}）`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Modal
        title={`${site.code} ${site.name} の QR`}
        onClose={onClose}
        size="lg"
        foot={
          <>
            <button type="button" className="btn-plain" onClick={onClose}>閉じる</button>
            <button type="button" className="btn-primary works-btn-accent" disabled={busy} onClick={download}>
              {busy ? '作成中…' : 'PDF をダウンロード（A4・2 枚）'}
            </button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          新しい QR を発行しました。<strong>これまでに掲示していたこの現場の QR は使えなくなりました。</strong>
          PDF を印刷して、出勤用・退勤用を現場に掲示してください（出入口が複数あれば、同じものを何枚貼ってもかまいません）。
        </p>
        <p className="ui-note" style={{ margin: 0 }}>
          QR の中身は安全のため保存していません。この画面を閉じたあとで印刷し直すときは、もう一度「QR を発行」してください（その時点で古い QR は使えなくなります）。
        </p>
        <div className="works-qr-preview">
          {KINDS.map(({ k, label, color }) => (
            <figure key={k} style={{ borderColor: color }}>
              <img src={qrs[k]} alt={`${label}用の QR`} />
              <figcaption style={{ color }}>{label}</figcaption>
            </figure>
          ))}
        </div>
        {error && <p className="works-error">{error}</p>}
      </Modal>
      {createPortal(
        <div ref={sheetsRef} className="works-qr-sheets" aria-hidden="true">
          {KINDS.map(({ k, label, color, note }) => (
            <div key={k} className="works-qr-sheet" style={{ borderColor: color }}>
              <div className="works-qr-sheet-kind" style={{ background: color }}>{label}</div>
              <div className="works-qr-sheet-site">{site.name}</div>
              {site.detail && <div className="works-qr-sheet-detail">{site.detail}</div>}
              <img className="works-qr-sheet-code" src={qrs[k]} alt="" />
              <div className="works-qr-sheet-note" style={{ color }}>{note}</div>
              <div className="works-qr-sheet-how">
                スマートフォンの <b>eWorks</b> アプリを開き、ホームの「{label}を記録」を押して、この QR を枠に入れてください。
              </div>
              <div className="works-qr-sheet-foot">
                eWorks 勤怠管理　現場コード {site.code}　発行 {issued}
              </div>
            </div>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}
