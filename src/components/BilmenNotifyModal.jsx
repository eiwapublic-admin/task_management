import { useEffect, useState } from 'react'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import { fetchBilmenMailSettings, fetchBilmenMailRecipients, notifyTargets, expandMailVariables, buildBilmenNoticeMailto } from '../lib/bilmen'
import '../pages/Bilmen.css'

// テナントへの報知（docs/bilmen-plan.md 7-3・3-5）。
// 現時点では mailto:（方式B）のみ実装している。Gmail下書き作成（方式A。PDF自動添付）は
// gmail.compose の書き込み実装が別途要るため未着手（このモーダルの案内文で明示する）。
// mailto: はファイルを添付できないため、先に連絡票PDFを保存してから、開いたメール作成
// 画面に手動で添付してもらう運用にする。
export default function BilmenNotifyModal({ month, schedules, onDownloadNotice, onClose }) {
  useBodyScrollLock()

  const [settings, setSettings] = useState(null)
  const [recipients, setRecipients] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    Promise.all([fetchBilmenMailSettings(), fetchBilmenMailRecipients()])
      .then(([s, r]) => {
        if (!alive) return
        setSettings(s)
        setRecipients(r)
      })
      .catch((err) => alive && setError(err.message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  const targets = notifyTargets(schedules)
  const activeRecipients = recipients.filter((r) => !r.disabled)

  const subject = settings ? expandMailVariables(settings.subject, { month, count: targets.length }) : ''
  const body = settings ? expandMailVariables(settings.body, { month, count: targets.length }) : ''
  const mailtoUrl = settings
    ? buildBilmenNoticeMailto(
        subject,
        body,
        activeRecipients.map((r) => r.email),
      )
    : '#'

  return (
    <div className="ui-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="ui-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h2>{month.replace('-', '年')}月のテナントへ報知</h2>
          <button type="button" className="icon-btn-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>
        <div className="ui-modal-body is-stacked">
          {error && (
            <p className="dashboard-error dashboard-banner" role="alert">
              {error}
            </p>
          )}
          {loading ? (
            <p className="dashboard-loading">読み込み中…</p>
          ) : (
            <>
              <p>
                対象件数（報知☑・予定日付あり・中止でない）: <strong>{targets.length}</strong>件 ／ 宛先:{' '}
                <strong>{activeRecipients.length}</strong>件
              </p>
              {targets.length === 0 && (
                <p className="bilmen-undecided">この月には報知対象の予定がありません。</p>
              )}
              {activeRecipients.length === 0 && (
                <p className="bilmen-undecided">
                  有効な宛先が登録されていません。ハンバーガーメニューの「メール設定」から登録してください。
                </p>
              )}

              <div className="ui-field">
                <label>件名（プレビュー）</label>
                <input className="ui-input" value={subject} readOnly />
              </div>
              <div className="ui-field">
                <label>本文（プレビュー）</label>
                <textarea className="ui-textarea" rows={6} value={body} readOnly />
              </div>

              <p className="bilmen-undecided">
                mailto: はファイルを添付できないため、①下のボタンで連絡票PDFを保存し、
                ②「メールを作成」で開く画面にPDFを手動で添付してから送信してください。
              </p>

              <div className="bilmen-generate-actions">
                <button type="button" className="btn-plain" onClick={() => onDownloadNotice(month, schedules)}>
                  ①連絡票PDFを作成
                </button>
                <a
                  className={`btn-primary${targets.length === 0 || activeRecipients.length === 0 ? ' is-disabled' : ''}`}
                  href={mailtoUrl}
                  aria-disabled={targets.length === 0 || activeRecipients.length === 0}
                  onClick={(e) => {
                    if (targets.length === 0 || activeRecipients.length === 0) e.preventDefault()
                  }}
                >
                  ②メールを作成
                </a>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
