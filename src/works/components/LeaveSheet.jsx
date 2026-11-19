// 有給休暇申請書の印刷（依頼元の「有給休暇申請書_入力用」と同じ様式。A4 縦に同じものを上下 2 枚、真ん中に切り取り線）。
// 申請から開くと申請日・氏名・日時・事由を入れ、空欄の用紙も出せる。連絡先は手書き（このシステムでは持たない）。
// PDF は画面外の A4 シートを html2canvas で撮って jsPDF に載せる（QrSheet と同じ。iPhone のホーム画面アプリは印刷できないため PDF）
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Modal from './Modal.jsx'
import { dateRanges, jpDate } from '../lib/leave.js'
import { todayJst } from '../../../worker/lib/works/time.js'

function Form({ request, name }) {
  const ranges = request ? dateRanges(request.dates) : []
  // 日時の欄は 2 行。3 つ以上のまとまりは 2 行目に続けて書く
  const rows = ranges.length <= 2 ? [ranges[0], ranges[1]] : [ranges[0], null]
  const rest = ranges.length > 2 ? ranges.slice(1) : []
  const applied = request ? todayJst(new Date(request.applied_at)) : null
  const reason = request ? [request.kind === 'special' ? '特別休暇' : '', request.reason || ''].filter(Boolean).join('　') : ''
  return (
    <div className="works-lf">
      <div className="works-lf-title">有 給 休 暇 申 請 書</div>
      <div className="works-lf-head">
        <div>申請日　{applied ? jpDate(applied) : ''}</div>
        <div className="works-lf-name">氏名：<span>{name || ''}</span></div>
      </div>
      <table className="works-lf-table">
        <tbody>
          <tr>
            <th rowSpan={2}>日時</th>
            <td className="works-lf-range">
              {rows[0] ? <><span>{jpDate(rows[0].from)}</span>～<span>{jpDate(rows[0].to)}</span></> : <><span />～<span /></>}
            </td>
          </tr>
          <tr>
            <td className="works-lf-range">
              {rows[1] ? (
                <><span>{jpDate(rows[1].from)}</span>～<span>{jpDate(rows[1].to)}</span></>
              ) : rest.length ? (
                <span className="works-lf-rest">{rest.map((r) => (r.from === r.to ? jpDate(r.from) : `${jpDate(r.from)}～${jpDate(r.to)}`)).join('、')}</span>
              ) : (
                <><span />～<span /></>
              )}
            </td>
          </tr>
          <tr className="works-lf-tall">
            <th>事由</th>
            <td>{reason}</td>
          </tr>
          <tr>
            <th>連絡先</th>
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  )
}

export default function LeaveSheet({ request = null, name = '', onClose }) {
  const ref = useRef(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const download = async () => {
    setBusy(true)
    setError('')
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')])
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
      const canvas = await html2canvas(ref.current, { scale: 2, backgroundColor: '#ffffff' })
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, 210, Math.min((canvas.height / canvas.width) * 210, 297), undefined, 'FAST')
      pdf.save(request ? `有給休暇申請書_${request.dates[0]}.pdf` : '有給休暇申請書.pdf')
    } catch (e) {
      setError(`PDF の作成に失敗しました（${e instanceof Error ? e.message : String(e)}）`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Modal
        title="有給休暇申請書の印刷"
        onClose={onClose}
        size="lg"
        foot={
          <button type="button" className="btn-primary works-btn-accent" disabled={busy} onClick={download}>
            {busy ? '作成中…' : 'PDF をダウンロード（A4 縦 1 枚に 2 枚分）'}
          </button>
        }
      >
        <p style={{ margin: 0 }}>
          {request ? '申請の内容を入れた申請書です。' : '空欄の申請書です。'}A4 縦 1 枚に同じものを上下 2 枚分並べています。連絡先は手書きでご記入ください。
        </p>
        <div className="works-lf-preview">
          <Form request={request} name={name} />
        </div>
        {error && <div className="works-error">{error}</div>}
      </Modal>
      {createPortal(
        <div className="works-lf-offscreen" aria-hidden="true">
          <div className="works-lf-sheet" ref={ref}>
            <Form request={request} name={name} />
            <div className="works-lf-cut" />
            <Form request={request} name={name} />
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
