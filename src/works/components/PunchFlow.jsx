// 打刻の流れ（docs/eworks-plan.md 6-2）: QR を読む → 送る → 記録完了（大きなチェック・時刻・振動）
//   preset … /p から開いたとき（標準カメラで QR を読んだ）は QR の中身を渡し、読み取りを飛ばす
//   telework … テレワークの日の自己申告。QR も位置情報も使わず、押した時刻で記録する
import { useEffect, useRef, useState } from 'react'
import QrScanner from './QrScanner.jsx'
import { parsePunchQr } from '../lib/qr.js'
import { getLocation, sendPunch, sendSelfPunch, vibrate } from '../lib/punch.js'
import { hoursLabel } from '../../../worker/lib/works/time.js'

const KIND = { in: '出勤', out: '退勤' }

export default function PunchFlow({ expected, preset = null, telework = false, onClose, onDone }) {
  const [step, setStep] = useState(preset || telework ? 'sending' : 'scan')
  const [qr, setQr] = useState(telework ? { k: expected } : preset)
  const [message, setMessage] = useState('')
  const [result, setResult] = useState(null)
  // 本人に見せる「確認のため知らせる」印（二重の読み取り・テレワークは知らせない）
  const notice = (result?.flag_labels || []).filter((f) => f !== '二重の読み取り' && !f.startsWith('テレワーク'))
  const locRef = useRef(null)
  const busy = useRef(false)

  // 位置情報は読み取りと並行して取りにいく（待ち時間を短くするため）
  useEffect(() => {
    if (!telework) locRef.current = getLocation()
  }, [telework])

  const submit = async (q, confirm = false) => {
    if (busy.current) return
    busy.current = true
    setStep('sending')
    try {
      const r = telework ? await sendSelfPunch(q.k, { confirm }) : await sendPunch(q, await locRef.current, { confirm })
      if (r.needsConfirm) {
        setMessage(r.message)
        setStep('confirm')
      } else if (r.queued) {
        vibrate()
        setStep('queued')
        onDone?.()
      } else {
        vibrate()
        setResult(r.result)
        setStep('done')
        onDone?.()
      }
    } catch (e) {
      setMessage(e.message)
      setStep('error')
    } finally {
      busy.current = false
    }
  }

  useEffect(() => {
    if (preset) submit(preset)
    else if (telework) submit({ k: expected })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onScan = (text) => {
    if (step !== 'scan') return
    const q = parsePunchQr(text)
    if (!q) {
      setMessage('eWorks の打刻用の QR ではありません')
      return
    }
    setQr(q)
    if (expected && q.k !== expected) {
      setStep('kind')
      return
    }
    submit(q)
  }

  return (
    <div className="works-punch" role="dialog" aria-modal="true">
      <div className="works-punch-head">
        <strong>{qr ? `${KIND[qr.k]}の記録` : expected ? `${KIND[expected]}の記録` : '出勤・退勤の記録'}</strong>
        <button type="button" className="icon-btn-close" aria-label="閉じる" onClick={onClose}>×</button>
      </div>

      {step === 'scan' && (
        <>
          <p className="works-punch-lead">現場に掲示された{expected ? `「${KIND[expected]}」の` : ''} QR コードを枠に入れてください</p>
          <QrScanner onResult={onScan} />
          {message && <p className="works-error">{message}</p>}
        </>
      )}

      {step === 'sending' && <p className="works-punch-lead">記録しています…</p>}

      {step === 'kind' && (
        <div className="works-punch-box">
          <p>読み取ったのは<strong>「{KIND[qr.k]}」</strong>の QR です。{KIND[qr.k]}を記録しますか？</p>
          <div className="works-row-actions">
            <button type="button" className="btn-primary works-btn-accent" onClick={() => submit(qr)}>{KIND[qr.k]}を記録する</button>
            <button type="button" className="btn-plain" onClick={() => { setQr(null); setMessage(''); setStep('scan') }}>読み直す</button>
          </div>
        </div>
      )}

      {step === 'confirm' && (
        <div className="works-punch-box">
          <p>{message}</p>
          <div className="works-row-actions">
            <button type="button" className="btn-primary works-btn-accent" onClick={() => submit(qr, true)}>退勤だけ記録する</button>
          </div>
        </div>
      )}

      {step === 'done' && result && (
        <div className="works-punch-done">
          <div className="works-punch-check" aria-hidden="true">✓</div>
          <div className="works-punch-kind">{KIND[result.kind]}を記録しました</div>
          <div className="works-punch-time">{result.time}</div>
          <div>{result.site?.name}</div>
          {result.flags?.includes('duplicate') ? (
            <p className="works-muted">すでに記録済みのため、勤務の時刻は変わっていません。</p>
          ) : (
            result.shift && (
              <p className="works-muted">
                予定 {result.shift.plan_start}〜{result.shift.plan_end}　勤務表には {result.adopted} で記録します
              </p>
            )
          )}
          {result.kind === 'out' && result.minutes != null && <p>今日の勤務 <strong>{hoursLabel(result.minutes)}</strong> 時間</p>}
          {notice.length > 0 && (
            <p className="works-punch-flags">確認のため管理者に知らせます: {notice.join('・')}</p>
          )}
          <button type="button" className="btn-primary works-btn-accent works-punch-close" onClick={onClose}>閉じる</button>
        </div>
      )}

      {step === 'queued' && (
        <div className="works-punch-done">
          <div className="works-punch-check is-queued" aria-hidden="true">✓</div>
          <div className="works-punch-kind">電波が届かないため、端末に保存しました</div>
          <p>電波が戻ったら自動で送ります（記録の時刻は今の時刻です）。</p>
          <button type="button" className="btn-primary works-btn-accent works-punch-close" onClick={onClose}>閉じる</button>
        </div>
      )}

      {step === 'error' && (
        <div className="works-punch-box">
          <p className="works-error">{message}</p>
          <div className="works-row-actions">
            {!preset && !telework && <button type="button" className="btn-primary works-btn-accent" onClick={() => { setQr(null); setMessage(''); setStep('scan') }}>読み直す</button>}
            <button type="button" className="btn-plain" onClick={onClose}>閉じる</button>
          </div>
        </div>
      )}
    </div>
  )
}
