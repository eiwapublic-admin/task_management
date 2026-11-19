// 現場の QR の掲示物（A4 横 1 枚に、左に出勤用・右に退勤用。必要なら真ん中で切る。docs/eworks-plan.md 6-1、2026-11-19 依頼元の要望）。
// 発行・再発行の直後と、「QR を印刷」（同じ QR の印刷し直し）で表示する。
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

export default function QrSheet({ site, token, reprint = false, onClose }) {
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
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' })
      const sheet = sheetsRef.current.querySelector('.works-qr-sheet')
      const canvas = await html2canvas(sheet, { scale: 2, backgroundColor: '#ffffff' })
      const h = (canvas.height / canvas.width) * 297
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, 297, Math.min(h, 210), undefined, 'FAST')
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
          <button type="button" className="btn-primary works-btn-accent" disabled={busy} onClick={download}>
            {busy ? '作成中…' : 'PDF をダウンロード（A4 横 1 枚）'}
          </button>
        }
      >
        {reprint ? (
          <p style={{ margin: 0 }}>いま掲示している QR と同じものです。印刷し直しても、掲示中の QR はそのまま使えます。</p>
        ) : (
          <p style={{ margin: 0 }}>
            新しい QR を発行しました。<strong>これまでに掲示していたこの現場の QR は使えなくなりました。</strong>
          </p>
        )}
        <p className="ui-note" style={{ margin: 0 }}>
          A4 横の 1 枚に、左に出勤用・右に退勤用を並べています。必要に応じて真ん中の点線で切ってください（出入口が複数あれば、同じものを何枚貼ってもかまいません）。
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
          <div className="works-qr-sheet">
            {KINDS.map(({ k, label, color, note }) => (
              <div key={k} className="works-qr-half" style={{ borderColor: color }}>
                <div className="works-qr-sheet-kind" style={{ background: color }}>{label}</div>
                <div className="works-qr-sheet-site">{site.name}</div>
                {site.detail && <div className="works-qr-sheet-detail">{site.detail}</div>}
                <img className="works-qr-sheet-code" src={qrs[k]} alt="" />
                <div className="works-qr-sheet-note" style={{ color }}>{note}</div>
                <div className="works-qr-sheet-how">
                  スマートフォンの <b>eWorks</b> アプリを開き、ホームの「{label}を記録」を押して、この QR を枠に入れてください。
                </div>
                <div className="works-qr-sheet-foot">eWorks 勤怠管理　現場コード {site.code}　発行 {issued}</div>
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
