// プッシュ通知のオン・オフ（設定画面）。管理者: 未出勤・修正申請／スタッフ: 退勤漏れ・予定の変更・修正申請の結果
import { useEffect, useState } from 'react'
import { disablePush, enablePush, getPushStatus, isIos, isStandalone } from '../lib/push.js'

export default function PushCard({ admin = false }) {
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    getPushStatus().then(setStatus)
  }, [])
  const toggle = async () => {
    setBusy(true)
    setError('')
    try {
      if (status === 'subscribed') await disablePush()
      else await enablePush()
      setStatus(await getPushStatus())
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  const needsHome = isIos() && !isStandalone()
  return (
    <div className="ui-card" style={{ marginTop: 12 }}>
      <div className="ui-card-title">通知（この端末）</div>
      <p className="ui-note" style={{ marginTop: 0 }}>
        {admin
          ? '出勤予定を過ぎても出勤の記録がないスタッフ（未出勤）と、打刻の修正申請をお知らせします。'
          : '退勤の記録を忘れたとき・予定が変わったとき・修正申請の結果をお知らせします。'}
      </p>
      {status === 'unsupported' || needsHome ? (
        <p className="works-muted" style={{ margin: 0 }}>
          {isIos() ? 'iPhone・iPad では、Safari の共有ボタン（□に↑）→「ホーム画面に追加」で追加した eWorks を開くと、ここで通知をオンにできます。' : 'この端末・ブラウザは通知に対応していません。'}
        </p>
      ) : status === 'denied' ? (
        <p className="works-muted" style={{ margin: 0 }}>通知がブロックされています。端末の設定（またはブラウザのサイトの設定）で eWorks の通知を許可してください。</p>
      ) : (
        <div className="works-row-actions" style={{ marginBottom: 0 }}>
          <span>{status === 'subscribed' ? 'オン' : 'オフ'}</span>
          <button type="button" className={status === 'subscribed' ? 'btn-plain' : 'btn-primary works-btn-accent'} disabled={busy || status === null} onClick={toggle}>
            {status === 'subscribed' ? '通知をオフにする' : '通知をオンにする'}
          </button>
        </div>
      )}
      {error && <div className="works-error">{error}</div>}
    </div>
  )
}
