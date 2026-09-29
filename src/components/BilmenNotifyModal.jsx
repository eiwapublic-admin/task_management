import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
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

// テナントへの報知（docs/bilmen-plan.md 7-3・3-5）。2つの方式を左右に並べて出す。
//
//   左: メールソフト方式（方式B。2026-09-03〜）… mailto: で端末のメールソフトを開く。
//     mailto: は仕様上ファイルを添付できないため、先に連絡票をダウンロードし、
//     開いたメール作成画面に手で添付してもらう
//   右: Gmail方式（方式A。2026-09-29〜。Phase 4'）… 共有アドレスの Gmail に、連絡票PDFを
//     添付した下書きを自動で作る。人が Gmail で中身を確かめて送る
//
// 2026-09-29 の依頼で「方式A/B」の呼び名をやめ、画面上は「メールソフト方式」「Gmail方式」とし、
// 左右に分けて目立たせた（依頼どおりメールソフト方式が左）。両方式を実際に使って
// 「どちらにするか・併用するか」を決める段階のため、どちらも同じ重みで並べている。
// 件名・本文・返信先はどちらもメール設定の値（下のプレビューと同じもの）。
// noticeError: 連絡票PDFの作成に失敗したときのメッセージ（連絡票のフックが持つ）。
// 一覧画面にも出るが、このモーダルの裏に隠れて見えないため、ここでも出す
export default function BilmenNotifyModal({ month, schedules, onDownloadNotice, onBuildNotice, noticeError, onClose }) {
  useBodyScrollLock()

  const [settings, setSettings] = useState(null)
  const [recipients, setRecipients] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // Gmail方式の進み具合: idle → pdf（連絡票PDFを作成中）→ draft（Gmailに登録中）→ done
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

  const replyTo = settings?.reply_to || ''
  const subject = settings ? expandMailVariables(settings.subject, { month, count: targets.length }) : ''
  const body = settings ? expandMailVariables(settings.body, { month, count: targets.length }) : ''
  const mailtoUrl = settings ? buildBilmenNoticeMailto(subject, body, activeRecipients, replyTo) : '#'

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
      // 宛先・返信先はサーバーがメール設定から引き直す（ここからは送らない）
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
          {/* 宛先・返信先をここで変えられないことを先に伝える（2026-09-29の依頼で右上に置いた） */}
          <p className="bilmen-notify-settings-note">
            ※ 宛先と返信先は<Link to="/bilmen/mail">メール設定</Link>の画面で指定します。
          </p>

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
                <label>返信先</label>
                <input
                  className="ui-input"
                  value={replyTo || '（未設定：送信元のアドレスに返信されます）'}
                  readOnly
                />
              </div>
              <div className="ui-field">
                <label>件名（プレビュー）</label>
                <input className="ui-input" value={subject} readOnly />
              </div>
              <div className="ui-field">
                <label>本文（プレビュー）</label>
                <textarea className="ui-textarea" rows={6} value={body} readOnly />
              </div>

              {(draftError || noticeError) && (
                <p className="dashboard-error dashboard-banner" role="alert">
                  {draftError || noticeError}
                </p>
              )}

              <p className="bilmen-notify-lead">下記の２つの方式のいずれかでメールを作成してください。</p>

              <div className="bilmen-notify-methods">
                {/* --- 左: メールソフト方式（mailto:。連絡票は手動で添付） --- */}
                <section className="bilmen-notify-method is-mailto">
                  <div className="bilmen-notify-method-head">
                    <h3 className="bilmen-notify-method-title">メールソフト方式</h3>
                    <p className="bilmen-notify-method-sub">手動で連絡票ファイルを添付</p>
                  </div>
                  <div className="bilmen-notify-method-body">
                    <p className="bilmen-notify-method-note">
                      ① 連絡票をダウンロード　② メールは自動作成されるので①を手動で添付してください。
                    </p>
                    <div className="bilmen-notify-method-actions">
                      <button
                        type="button"
                        className="btn-plain"
                        onClick={() => onDownloadNotice(month, schedules)}
                        disabled={drafting}
                      >
                        ① 連絡票をダウンロード
                      </button>
                      <a
                        className={`btn-primary${cannotSend ? ' is-disabled' : ''}`}
                        href={mailtoUrl}
                        aria-disabled={cannotSend}
                        onClick={(e) => {
                          if (cannotSend) e.preventDefault()
                        }}
                      >
                        ② メールを作成
                      </a>
                    </div>
                  </div>
                </section>

                {/* --- 右: Gmail方式（Gmail下書き。連絡票は自動添付） --- */}
                <section className="bilmen-notify-method is-gmail">
                  <div className="bilmen-notify-method-head">
                    <h3 className="bilmen-notify-method-title">Gmail方式</h3>
                    <p className="bilmen-notify-method-sub">連絡票は自動添付</p>
                  </div>
                  <div className="bilmen-notify-method-body">
                    {/* 下書きはサーバーが持つ共有アドレスのトークンで作るため、端末でどの Google
                        アカウントにログインしていても送信元は共有アドレスになる（2026-09-29に文言を修正） */}
                    <p className="bilmen-notify-method-note">送信元は、eiwa.public@gmail.com となります。</p>
                    {/* Gmail の画面から送ると Reply-To が落ちる（Gmail がメールを組み立て直すため。
                        実機で確認済み・7-3-3）ので、返信先は本文の末尾に書き添える（2026-09-29の依頼） */}
                    {replyTo && (
                      <p className="bilmen-notify-method-note is-muted">
                        本文の末尾に「ご返信は {replyTo} までお願いいたします。」を付けて作成します。
                      </p>
                    )}

                    {/* 作成後は「下書きを開く」をこの枠の中に出す（2026-09-29の依頼。以前は2列の下に
                        別枠で出していたが、操作の流れが分かりにくく、画面の下に隠れて気づきにくかった） */}
                    {draftStep === 'done' && draftResult && (
                      <div className="bilmen-notify-done" role="status">
                        <p className="bilmen-notify-done-title">✓ 下書きを作成しました</p>
                        <p className="bilmen-notify-method-note">
                          宛先 {draftResult.recipient_count} 件・連絡票を添付。<strong>まだ送信されていません。</strong>
                        </p>
                        <a
                          className="btn-primary bilmen-notify-open"
                          href={draftResult.draft_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Gmail で下書きを開く
                        </a>
                        {/* 下書きが直接開かなかったときの逃げ道。普段は使わないので小さく添えるだけ */}
                        <a className="bilmen-notify-sublink" href={draftResult.drafts_url} target="_blank" rel="noreferrer">
                          開かないときは下書きフォルダへ
                        </a>
                      </div>
                    )}

                    <div className="bilmen-notify-method-actions">
                      <button
                        type="button"
                        className={draftStep === 'done' ? 'btn-plain' : 'btn-primary'}
                        onClick={handleCreateDraft}
                        disabled={cannotSend || drafting || !settings}
                      >
                        {draftStep === 'pdf'
                          ? '連絡票を作成中…'
                          : draftStep === 'draft'
                            ? 'Gmail に登録中…'
                            : draftStep === 'done'
                              ? '下書きをもう一度作成'
                              : 'Gmail に下書きを作成'}
                      </button>
                    </div>
                  </div>
                </section>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
