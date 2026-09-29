import { useEffect, useState } from 'react'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import {
  fetchBilmenMailSettings,
  fetchBilmenMailRecipients,
  notifyTargets,
  expandMailVariables,
  buildBilmenNoticeMailto,
  createBilmenMailDraft,
} from '../lib/bilmen'
import '../pages/Bilmen.css'

// テナントへの報知（docs/bilmen-plan.md 7-3・3-5）。2つの方式を並べて出す。
//
//   方式A（2026-09-29〜。Phase 4'）… 共有アドレスの Gmail に、連絡票PDFを添付した下書きを
//     自動で作る。宛先（BCC）もPDFも付いた状態で、人が Gmail で中身を確かめて送る
//   方式B（2026-09-03〜）… mailto: で端末のメールソフトを開く。mailto: は仕様上
//     ファイルを添付できないため、先に連絡票PDFを保存し、開いた画面に手で添付してもらう
//
// 2026-09-29時点では、両方式を実際に使ってみて「どちらにするか・併用するか」を依頼元が
// 判断する段階のため、どちらも同じ重みで並べている（判断が出たら片方を畳む想定）。
// 件名・本文はどちらもメール設定の雛形を展開したもの（下のプレビューと同じ文面）。
// noticeError: 連絡票PDFの作成に失敗したときのメッセージ（連絡票のフックが持つ）。
// 一覧画面にも出るが、このモーダルの裏に隠れて見えないため、ここでも出す
export default function BilmenNotifyModal({ month, schedules, onDownloadNotice, onBuildNotice, noticeError, onClose }) {
  useBodyScrollLock()

  const [settings, setSettings] = useState(null)
  const [recipients, setRecipients] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 方式A の進み具合: idle → pdf（連絡票PDFを作成中）→ draft（Gmailに登録中）→ done
  const [draftStep, setDraftStep] = useState('idle')
  const [draftResult, setDraftResult] = useState(null)
  const [draftError, setDraftError] = useState('')

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
  const cannotSend = targets.length === 0 || activeRecipients.length === 0

  const subject = settings ? expandMailVariables(settings.subject, { month, count: targets.length }) : ''
  const body = settings ? expandMailVariables(settings.body, { month, count: targets.length }) : ''
  const mailtoUrl = settings ? buildBilmenNoticeMailto(subject, body, activeRecipients) : '#'

  const drafting = draftStep === 'pdf' || draftStep === 'draft'

  async function handleCreateDraft() {
    setDraftError('')
    setDraftResult(null)
    setDraftStep('pdf')
    try {
      // PDFは「連絡票」ボタンと同じもの（選んでいる版＝従来版／カード版もそのまま）
      const built = await onBuildNotice(month, schedules)
      if (!built) {
        // 作成失敗の理由は noticeError（連絡票のフック）として下に出る
        setDraftStep('idle')
        return
      }
      setDraftStep('draft')
      const result = await createBilmenMailDraft({ month, subject, body, pdfBlob: built.blob, filename: built.filename })
      setDraftResult(result)
      setDraftStep('done')
    } catch (err) {
      setDraftError(err.message)
      setDraftStep('idle')
    }
  }

  return (
    <div className="ui-overlay" role="dialog" aria-modal="true" onClick={drafting ? undefined : onClose}>
      <div className="ui-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h2>{month.replace('-', '年')}月のテナントへ報知</h2>
          <button type="button" className="icon-btn-close" onClick={onClose} disabled={drafting} aria-label="閉じる">
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

              {/* --- 方式A: Gmail 下書き（PDF自動添付） --- */}
              <section className="bilmen-notify-method">
                <h3 className="bilmen-notify-method-title">
                  <span className="bilmen-notify-method-badge">A</span>
                  Gmail に下書きを作成（PDFを自動で添付）
                </h3>
                <p className="bilmen-notify-method-note">
                  連絡票PDFを作り、宛先（BCC）とPDFが付いた下書きを共有アドレスの Gmail に作ります。
                  <strong>まだ送信はされません</strong>。Gmail で中身を確かめてから送信してください。
                </p>

                {(draftError || noticeError) && (
                  <p className="dashboard-error dashboard-banner" role="alert">
                    {draftError || noticeError}
                  </p>
                )}

                {draftStep === 'done' && draftResult ? (
                  <div className="bilmen-notify-done" role="status">
                    <p>
                      下書きを作成しました（宛先 <strong>{draftResult.recipient_count}</strong> 件・
                      {draftResult.filename} を添付）。
                    </p>
                    <div className="bilmen-generate-actions">
                      <a className="btn-primary" href={draftResult.draft_url} target="_blank" rel="noreferrer">
                        Gmail で下書きを開く
                      </a>
                      <a className="btn-plain" href={draftResult.drafts_url} target="_blank" rel="noreferrer">
                        下書きフォルダを開く
                      </a>
                    </div>
                    <p className="bilmen-notify-method-note">
                      下書きが直接開かないときは「下書きフォルダを開く」から、いちばん上の下書きを開いてください。
                      下のボタンをもう一度押すと<strong>別の下書きがもう1通</strong>できます（不要な分は Gmail で削除）。
                    </p>
                  </div>
                ) : null}

                <div className="bilmen-generate-actions">
                  <button
                    type="button"
                    className={draftStep === 'done' ? 'btn-plain' : 'btn-primary'}
                    onClick={handleCreateDraft}
                    disabled={cannotSend || drafting || !settings}
                  >
                    {draftStep === 'pdf'
                      ? '連絡票PDFを作成中…'
                      : draftStep === 'draft'
                        ? 'Gmail に登録中…'
                        : draftStep === 'done'
                          ? '下書きをもう一度作成'
                          : 'Gmail に下書きを作成'}
                  </button>
                </div>
              </section>

              {/* --- 方式B: mailto:（PDFは手動で添付） --- */}
              <section className="bilmen-notify-method">
                <h3 className="bilmen-notify-method-title">
                  <span className="bilmen-notify-method-badge is-b">B</span>
                  メールソフトで作成（PDFは手動で添付）
                </h3>
                <p className="bilmen-notify-method-note">
                  mailto: はファイルを添付できないため、①で連絡票PDFを保存し、
                  ②で開くメール作成画面にPDFを手動で添付してから送信してください。
                </p>
                <div className="bilmen-generate-actions">
                  <button
                    type="button"
                    className="btn-plain"
                    onClick={() => onDownloadNotice(month, schedules)}
                    disabled={drafting}
                  >
                    ①連絡票PDFを作成
                  </button>
                  <a
                    className={`btn-plain${cannotSend ? ' is-disabled' : ''}`}
                    href={mailtoUrl}
                    aria-disabled={cannotSend}
                    onClick={(e) => {
                      if (cannotSend) e.preventDefault()
                    }}
                  >
                    ②メールを作成
                  </a>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
