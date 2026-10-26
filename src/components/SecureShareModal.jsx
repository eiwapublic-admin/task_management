import { useEffect, useMemo, useState } from 'react'
import Combobox from './Combobox'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import './SecureShare.css'
import { TENANT_PDF_KINDS, buildTenantListPdfFile, defaultAsOf, defaultUpdateSince } from '../lib/tenantListPdf'
import {
  SHARE_DEFAULT_DAYS,
  SHARE_DEFAULT_OPENS,
  SHARE_MAX_DAYS,
  SHARE_MAX_OPENS,
  buildPasscodeSms,
  contactLabel,
  copyText,
  createSecureShare,
  formatShareDateTime,
  shareableContacts,
} from '../lib/secureShares'
import { fetchContacts } from '../lib/contacts'

// 安全なリンクで共有（2026-10-26〜）。テナント一覧表・緊急連絡先一覧表の PDF を作り、期限付き・パスコード付きの
// リンクにする。リンクとパスコードは作った直後のこの画面でしか見られない（サーバーはそのままの値を持たない）。
// 送り先は連絡帳から選ぶ（携帯電話番号とメールアドレスの両方があるものだけ）。リンクは Gmail の下書き、
// パスコードは SMS アプリの文面として作る（どちらも送信は人がする）
export default function SecureShareModal({ onClose }) {
  useBodyScrollLock()

  const [kind, setKind] = useState('emergency')
  const [since, setSince] = useState(defaultUpdateSince())
  const [asOf, setAsOf] = useState(defaultAsOf())
  const [contacts, setContacts] = useState(null)
  const [query, setQuery] = useState('')
  const [contactId, setContactId] = useState('')
  const [days, setDays] = useState(String(SHARE_DEFAULT_DAYS))
  const [maxOpens, setMaxOpens] = useState(String(SHARE_DEFAULT_OPENS))
  const [draft, setDraft] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [copied, setCopied] = useState('')

  useEffect(() => {
    let active = true
    fetchContacts()
      .then((list) => active && setContacts(shareableContacts(list)))
      .catch((err) => active && setError(err.message))
    return () => {
      active = false
    }
  }, [])

  const options = useMemo(() => (contacts || []).map((c) => ({ key: c.id, label: contactLabel(c) })), [contacts])
  const contact = contacts?.find((c) => c.id === contactId) || null

  function changeQuery(v) {
    setQuery(v)
    // 選んだ後に書き換えたら選び直し
    if (contact && v !== contactLabel(contact)) setContactId('')
  }

  async function handleCreate() {
    const d = Number(days)
    const m = Number(maxOpens)
    if (!contact) return setError('送り先を連絡帳から選んでください')
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
        contactId: contact.id,
        days: d,
        maxOpens: m,
        draft,
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
                PDF をメールに添付せず、期限付き・パスコード付きのリンクで渡します。リンクはメールで、パスコードは SMS やお電話など
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
              <div className="ui-field">
                <span>送り先（連絡帳から選ぶ）</span>
                <Combobox
                  value={query}
                  onChange={changeQuery}
                  onSelect={(key, label) => {
                    setContactId(key)
                    setQuery(label)
                  }}
                  options={options}
                  placeholder={contacts == null ? '読み込み中…' : '会社名・担当者名で検索'}
                  disabled={busy || contacts == null}
                />
              </div>
              {contact ? (
                <dl className="secure-share-contact">
                  <dt>メール</dt>
                  <dd>{contact.email_to}</dd>
                  <dt>携帯</dt>
                  <dd>{contact.mobile_phone}</dd>
                </dl>
              ) : (
                <p className="ui-note">
                  携帯電話番号とメールアドレスの両方が登録されている連絡先だけを出しています
                  {contacts ? `（${contacts.length}件）` : ''}。足りないときは連絡帳に登録してください。
                </p>
              )}
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
                <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} disabled={busy} />
                <span>リンクを書いたメールを Gmail の下書きに作る</span>
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
  const sms = share.recipient_mobile
    ? buildPasscodeSms({ mobile: share.recipient_mobile, title: share.title, passcode, expiresAt: share.expires_at })
    : null
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
        <span>パスコード（SMS やお電話など、メール以外で伝える）</span>
        <div className="secure-share-copy">
          <output className="secure-share-passcode">{passcode}</output>
          <button type="button" className="btn-plain" onClick={() => onCopy('passcode', passcode)}>
            {copied === 'passcode' ? 'コピーしました' : 'コピー'}
          </button>
        </div>
      </div>
      {copied.endsWith('-ng') && <p className="ui-note">この端末ではコピーできませんでした。欄を長押しして選んでください。</p>}
      <div className="secure-share-send">
        {draftUrl && (
          <a className="btn-plain" href={draftUrl} target="_blank" rel="noopener noreferrer">
            ① Gmail で下書きを開く（リンク）
          </a>
        )}
        {sms && (
          <a className="btn-plain" href={sms.href}>
            ② SMS を作る（パスコード → {share.recipient_mobile}）
          </a>
        )}
      </div>
      {sms && (
        <div className="ui-field">
          <span>SMS の文面</span>
          <div className="secure-share-copy">
            <textarea className="ui-textarea" rows={3} value={sms.body} readOnly onFocus={(e) => e.target.select()} />
            <button type="button" className="btn-plain" onClick={() => onCopy('sms', sms.body)}>
              {copied === 'sms' ? 'コピーしました' : 'コピー'}
            </button>
          </div>
        </div>
      )}
      {sms && (
        <p className="ui-note">
          スマホでは SMS アプリが宛先と文面入りで開きます（送信ボタンはご自身で押してください）。パソコンで開かないときは、文面をコピーしてスマホから送ってください。
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
