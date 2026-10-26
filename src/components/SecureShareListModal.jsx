import { useEffect, useState } from 'react'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import './SecureShare.css'
import {
  SHARE_LOG_RESULT,
  SHARE_STATUS,
  buildPasscodeSms,
  copyText,
  fetchSecureShares,
  formatShareDateTime,
  reissueSecureSharePasscode,
  revokeSecureShare,
} from '../lib/secureShares'

// 共有リンクの一覧（2026-10-26〜）。いつ誰に送ったか・開かれたか・パスコードの間違いを確かめ、
// 取り消しとパスコードの再発行をする
export default function SecureShareListModal({ onClose }) {
  useBodyScrollLock()

  const [shares, setShares] = useState(null)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [confirmId, setConfirmId] = useState(null)
  const [reissued, setReissued] = useState(null)

  useEffect(() => {
    let active = true
    fetchSecureShares()
      .then((res) => active && setShares(res.shares || []))
      .catch((err) => active && setError(err.message))
    return () => {
      active = false
    }
  }, [])

  function replace(share) {
    setShares((list) => list.map((s) => (s.id === share.id ? { ...s, ...share } : s)))
  }

  async function run(id, fn) {
    setBusyId(id)
    setError('')
    try {
      await fn()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  const revoke = (id) =>
    run(id, async () => {
      const res = await revokeSecureShare(id)
      replace(res.share)
      setConfirmId(null)
    })

  const reissue = (id) =>
    run(id, async () => {
      const res = await reissueSecureSharePasscode(id)
      replace(res.share)
      setReissued({ id, passcode: res.passcode })
    })

  return (
    <div className="ui-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="ui-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h3 className="ui-modal-title">共有リンクの一覧</h3>
          <button type="button" className="icon-btn-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>
        <div className="ui-modal-body secure-share-body">
          {error && (
            <p className="dashboard-error dashboard-banner" role="alert">
              {error}
            </p>
          )}
          <p className="ui-note">
            期限切れ・回数切れ・取り消したものは、毎日の定期処理で PDF を消します（記録は残ります）。
          </p>
          {shares == null && !error && <p className="ui-empty">読み込み中…</p>}
          {shares?.length === 0 && <p className="ui-empty">まだ共有はありません。</p>}
          {shares?.length > 0 && (
            <div className="ui-table-wrap">
              <table className="ui-table secure-share-table">
                <thead>
                  <tr>
                    <th>作成</th>
                    <th>書類・送り先</th>
                    <th>期限</th>
                    <th className="is-numeric">開いた</th>
                    <th>状態</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shares.map((s) => {
                    const st = SHARE_STATUS[s.status] || { label: s.status, badge: '' }
                    const canChange = s.status !== 'revoked' && s.status !== 'deleted'
                    const canReissue = s.status === 'active' || s.status === 'locked'
                    return (
                      <tr key={s.id}>
                        <td className="nowrap">
                          {formatShareDateTime(s.created_at)}
                          <div className="ui-note">{s.created_by}</div>
                        </td>
                        <td>
                          {s.title}
                          <div>{s.recipient_name} 様</div>
                          {s.recipient_email && <div className="ui-note">{s.recipient_email}</div>}
                          {s.recipient_mobile && <div className="ui-note">{s.recipient_mobile}</div>}
                          {s.log?.length > 0 && (
                            <details className="secure-share-log">
                              <summary>記録（{s.log.length}件）</summary>
                              <ul>
                                {s.log.map((l, i) => (
                                  <li key={i}>
                                    {formatShareDateTime(l.accessed_at)} {SHARE_LOG_RESULT[l.result] || l.result}
                                    {l.ip ? `（${l.ip}）` : ''}
                                  </li>
                                ))}
                              </ul>
                            </details>
                          )}
                          {reissued?.id === s.id && (
                            <div className="secure-share-reissued">
                              新しいパスコード: <output className="secure-share-passcode">{reissued.passcode}</output>
                              <button type="button" className="btn-plain" onClick={() => copyText(reissued.passcode)}>
                                コピー
                              </button>
                              {s.recipient_mobile && (
                                <a
                                  className="btn-plain"
                                  href={
                                    buildPasscodeSms({
                                      mobile: s.recipient_mobile,
                                      title: s.title,
                                      passcode: reissued.passcode,
                                      expiresAt: s.expires_at,
                                    }).href
                                  }
                                >
                                  SMS を作る
                                </a>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="nowrap">{formatShareDateTime(s.expires_at)}</td>
                        <td className="is-numeric nowrap">
                          {s.open_count} / {s.max_opens}
                        </td>
                        <td>
                          <span className={`ui-badge ${st.badge}`}>{st.label}</span>
                          {s.failed_attempts > 0 && s.status !== 'locked' && (
                            <div className="ui-note">誤り {s.failed_attempts} 回</div>
                          )}
                        </td>
                        <td>
                          <div className="secure-share-actions">
                          {canReissue && (
                            <button type="button" className="btn-plain" onClick={() => reissue(s.id)} disabled={busyId != null}>
                              パスコード再発行
                            </button>
                          )}
                          {canChange &&
                            (confirmId === s.id ? (
                              <>
                                <button type="button" className="btn-danger" onClick={() => revoke(s.id)} disabled={busyId != null}>
                                  取り消す
                                </button>
                                <button type="button" className="btn-plain" onClick={() => setConfirmId(null)}>
                                  やめる
                                </button>
                              </>
                            ) : (
                              <button type="button" className="btn-plain" onClick={() => setConfirmId(s.id)} disabled={busyId != null}>
                                取り消し
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="ui-modal-foot">
          <div className="ui-modal-foot-start" />
          <div className="ui-modal-foot-end">
            <button type="button" className="btn-plain" onClick={onClose}>
              閉じる
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
