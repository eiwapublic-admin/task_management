import { useState } from 'react'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import './SecureShare.css'
import { TENANT_PDF_KINDS, buildTenantListPdfFile, defaultAsOf, defaultUpdateSince } from '../lib/tenantListPdf'
import {
  SHARE_DEFAULT_DAYS,
  SHARE_DEFAULT_OPENS,
  SHARE_MAX_DAYS,
  SHARE_MAX_OPENS,
  copyText,
  createSecureShare,
  formatShareDateTime,
} from '../lib/secureShares'

// 安全なリンクで共有（2026-10-26〜）。テナント一覧表・緊急連絡先一覧表の PDF を作り、期限付き・パスコード付きの
// リンクにする。リンクとパスコードは作った直後のこの画面でしか見られない（サーバーはそのままの値を持たない）
export default function SecureShareModal({ onClose }) {
  useBodyScrollLock()

  const [kind, setKind] = useState('emergency')
  const [since, setSince] = useState(defaultUpdateSince())
  const [asOf, setAsOf] = useState(defaultAsOf())
  const [recipientName, setRecipientName] = useState('')
  const [recipientEmail, setRecipientEmail] = useState('')
  const [days, setDays] = useState(String(SHARE_DEFAULT_DAYS))
  const [maxOpens, setMaxOpens] = useState(String(SHARE_DEFAULT_OPENS))
  const [draft, setDraft] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [copied, setCopied] = useState('')

  const email = recipientEmail.trim()

  async function handleCreate() {
    const d = Number(days)
    const m = Number(maxOpens)
    if (!recipientName.trim()) return setError('送り先の名前を入力してください')
    if (!Number.isInteger(d) || d < 1 || d > SHARE_MAX_DAYS) return setError(`有効期限は 1〜${SHARE_MAX_DAYS} 日で入力してください`)
    if (!Number.isInteger(m) || m < 1 || m > SHARE_MAX_OPENS) return setError(`開ける回数は 1〜${SHARE_MAX_OPENS} 回で入力してください`)
    if (kind === 'emergency' && !since) return setError('起点の日付を入力してください')
    if (kind === 'tenants' && !asOf) return setError('時点の日付を入力してください')
    setBusy(true)
    setError('')
    try {
      const file = await buildTenantListPdfFile(kind, kind === 'emergency' ? { since } : { asOf })
      const res = await createSecureShare({
        pdfBlob: file.blob,
        filename: file.filename,
        title: TENANT_PDF_KINDS[kind].label,
        recipientName: recipientName.trim(),
        recipientEmail: email,
        days: d,
        maxOpens: m,
        draft: draft && !!email,
      })
      setResult(res)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function copy(key, value) {
    setCopied((await copyText(value)) ? key : `${key}-ng`)
  }

  return (
    <div className="ui-overlay" role="dialog" aria-modal="true" onClick={busy ? undefined : onClose}>
      <div className="ui-modal is-sm" onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h3 className="ui-modal-title">安全なリンクで共有</h3>
          <button type="button" className="icon-btn-close" onClick={onClose} disabled={busy} aria-label="閉じる">
            ×
          </button>
        </div>
        <div className="ui-modal-body secure-share-body">
          {error && (
            <p className="dashboard-error dashboard-banner" role="alert">
              {error}
            </p>
          )}
          {result ? (
            <ShareResult result={result} copied={copied} onCopy={copy} />
          ) : (
            <>
              <p className="ui-note">
                PDF をメールに添付せず、期限付き・パスコード付きのリンクで渡します。リンクはメールで、パスコードはお電話など
                <strong>メール以外の方法</strong>で伝えてください。
              </p>
              <label className="ui-field">
                <span>書類</span>
                <select className="ui-select" value={kind} onChange={(e) => setKind(e.target.value)} disabled={busy}>
                  <option value="emergency">{TENANT_PDF_KINDS.emergency.label}</option>
                  <option value="tenants">{TENANT_PDF_KINDS.tenants.label}</option>
                </select>
              </label>
              {kind === 'emergency' ? (
                <label className="ui-field">
                  <span>最終変更事項の起点の日付</span>
                  <input type="date" className="ui-input" value={since} onChange={(e) => setSince(e.target.value)} disabled={busy} />
                </label>
              ) : (
                <label className="ui-field">
                  <span>時点の日付（この日に退去済みのテナントは載せない）</span>
                  <input type="date" className="ui-input" value={asOf} onChange={(e) => setAsOf(e.target.value)} disabled={busy} />
                </label>
              )}
              <label className="ui-field">
                <span>送り先の名前（〇〇 様）</span>
                <input
                  type="text"
                  className="ui-input"
                  value={recipientName}
                  onChange={(e) => setRecipientName(e.target.value)}
                  placeholder="例: 小泉産業株式会社 山田"
                  maxLength={100}
                  disabled={busy}
                />
              </label>
              <label className="ui-field">
                <span>送り先のメールアドレス（任意）</span>
                <input
                  type="email"
                  className="ui-input"
                  value={recipientEmail}
                  onChange={(e) => setRecipientEmail(e.target.value)}
                  placeholder="example@example.co.jp"
                  maxLength={254}
                  disabled={busy}
                />
              </label>
              <div className="ui-field-row">
                <label className="ui-field">
                  <span>有効期限（日）</span>
                  <input
                    type="number"
                    className="ui-input"
                    inputMode="numeric"
                    min={1}
                    max={SHARE_MAX_DAYS}
                    value={days}
                    onChange={(e) => setDays(e.target.value)}
                    disabled={busy}
                  />
                </label>
                <label className="ui-field">
                  <span>開ける回数</span>
                  <input
                    type="number"
                    className="ui-input"
                    inputMode="numeric"
                    min={1}
                    max={SHARE_MAX_OPENS}
                    value={maxOpens}
                    onChange={(e) => setMaxOpens(e.target.value)}
                    disabled={busy}
                  />
                </label>
              </div>
              <label className="secure-share-check">
                <input type="checkbox" checked={draft && !!email} onChange={(e) => setDraft(e.target.checked)} disabled={busy || !email} />
                <span>リンクを書いたメールを Gmail の下書きに作る{email ? '' : '（メールアドレスを入れると選べます）'}</span>
              </label>
            </>
          )}
        </div>
        <div className="ui-modal-foot">
          <div className="ui-modal-foot-start" />
          <div className="ui-modal-foot-end">
            {result ? (
              <button type="button" className="btn-primary" onClick={onClose}>
                閉じる
              </button>
            ) : (
              <>
                <button type="button" className="btn-plain" onClick={onClose} disabled={busy}>
                  キャンセル
                </button>
                <button type="button" className="btn-primary" onClick={handleCreate} disabled={busy}>
                  {busy ? '作成中…' : 'リンクを作る'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ShareResult({ result, copied, onCopy }) {
  const { share, url, passcode, draft_url: draftUrl, draft_error: draftError } = result
  return (
    <>
      <p className="ui-note">
        {share.recipient_name} 様あての共有を作りました。有効期限は {formatShareDateTime(share.expires_at)} まで、開ける回数は{' '}
        {share.max_opens} 回までです。
      </p>
      <div className="ui-field">
        <span>リンク（メールで送る）</span>
        <div className="secure-share-copy">
          <input type="text" className="ui-input" value={url} readOnly onFocus={(e) => e.target.select()} />
          <button type="button" className="btn-plain" onClick={() => onCopy('url', url)}>
            {copied === 'url' ? 'コピーしました' : 'コピー'}
          </button>
        </div>
      </div>
      <div className="ui-field">
        <span>パスコード（お電話など、メール以外で伝える）</span>
        <div className="secure-share-copy">
          <output className="secure-share-passcode">{passcode}</output>
          <button type="button" className="btn-plain" onClick={() => onCopy('passcode', passcode)}>
            {copied === 'passcode' ? 'コピーしました' : 'コピー'}
          </button>
        </div>
      </div>
      {copied.endsWith('-ng') && <p className="ui-note">この端末ではコピーできませんでした。欄を長押しして選んでください。</p>}
      {draftUrl && (
        <p>
          <a className="btn-plain" href={draftUrl} target="_blank" rel="noopener noreferrer">
            Gmail で下書きを開く
          </a>
        </p>
      )}
      {draftError && (
        <p className="dashboard-error dashboard-banner" role="alert">
          {draftError}
        </p>
      )}
      <p className="ui-note">
        この画面を閉じると、リンクとパスコードはもう表示できません。パスコードを忘れたときは「共有リンクの一覧」から再発行できます。
        パスコードは<strong>メールに書かないでください</strong>。
      </p>
    </>
  )
}
