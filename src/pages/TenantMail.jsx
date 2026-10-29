import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import ConfirmDeleteButton from '../components/ConfirmDeleteButton'
import {
  fetchBilmenMailSettings,
  updateBilmenMailSettings,
  fetchBilmenMailRecipients,
  createBilmenMailRecipient,
  updateBilmenMailRecipient,
  deleteBilmenMailRecipient,
  activeBilmenRecipients,
  groupBilmenRecipients,
  buildBilmenNoticeMailto,
} from '../lib/bilmen'
import {
  fetchTenantMailTemplates,
  createTenantMailTemplate,
  updateTenantMailTemplate,
  deleteTenantMailTemplate,
  createTenantMailDraft,
  expandTenantMailVariables,
  TENANT_MAIL_VARIABLES,
} from '../lib/tenantMail'
import './Dashboard.css'
import './Bilmen.css'
import './TenantMail.css'

// テナントへのメール（雛型からの一斉メール。2026-10-29〜）。
// 件名・本文の雛型を複数登録し、選んだ雛型から「有効なテナント全員を BCC」にしたメールを作る。
// 方式はビルメンの「テナントへ報知」と同じ2つ（メールソフト方式＝mailto:／Gmail方式＝共有アドレスの下書き）。
// 旧「ビルメン メール設定」（/bilmen/mail）はこの画面の「宛先・返信先」タブに合流し、
// ビルメンの案内メールの件名・本文は雛型の1つ（kind='bilmen'）になった（作成は連絡票PDFを添付するため
// 従来どおりビルメンテナンス管理の「テナントへ報知」から）。
// 外部に出る操作の一部のため社員のみ（App.jsx の RequireStaff。API 側も requireMailAccess で同じ判定）。
const TABS = [
  { key: 'compose', label: 'メール作成' },
  { key: 'templates', label: '雛型' },
  { key: 'recipients', label: '宛先・返信先' },
]

const floorLabel = (f) => (f ? (f === 'B' ? 'B1F' : `${f}F`) : '')

export default function TenantMail() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = TABS.some((t) => t.key === searchParams.get('tab')) ? searchParams.get('tab') : 'compose'

  const [templates, setTemplates] = useState([])
  const [settings, setSettings] = useState(null)
  const [recipients, setRecipients] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [t, s, r] = await Promise.all([fetchTenantMailTemplates(), fetchBilmenMailSettings(), fetchBilmenMailRecipients()])
      setTemplates(t)
      setSettings(s)
      setRecipients(r)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-wide app-scroll">
        <FeatureHeader
          filters={
            <div className="ui-segmented" role="group" aria-label="表示">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={`ui-segmented-btn${tab === t.key ? ' is-active' : ''}`}
                  aria-pressed={tab === t.key}
                  onClick={() => setSearchParams(t.key === 'compose' ? {} : { tab: t.key }, { replace: true })}
                >
                  {t.label}
                </button>
              ))}
            </div>
          }
        />

        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : tab === 'templates' ? (
          <TemplatesTab templates={templates} setTemplates={setTemplates} />
        ) : tab === 'recipients' ? (
          <RecipientsTab settings={settings} setSettings={setSettings} recipients={recipients} setRecipients={setRecipients} />
        ) : (
          <ComposeTab templates={templates} settings={settings} recipients={recipients} />
        )}
      </div>
    </div>
  )
}

// ---- メール作成 ----
function ComposeTab({ templates, settings, recipients }) {
  const generalTemplates = templates.filter((t) => t.kind !== 'bilmen')
  const [templateId, setTemplateId] = useState(generalTemplates[0]?.id || templates[0]?.id || '')
  const template = templates.find((t) => t.id === templateId) || null
  const isBilmen = template?.kind === 'bilmen'

  // 件名・本文は雛型を展開したものを初期値にし、送る前にこの画面で書き足せるようにする
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  useEffect(() => {
    setSubject(template ? expandTenantMailVariables(template.subject) : '')
    setBody(template ? expandTenantMailVariables(template.body) : '')
  }, [template])

  const [draftStep, setDraftStep] = useState('idle') // idle → draft → done
  const [draftResult, setDraftResult] = useState(null)
  const [draftError, setDraftError] = useState('')
  const [openKey, setOpenKey] = useState(null)
  useEffect(() => {
    setDraftStep('idle')
    setDraftResult(null)
    setDraftError('')
  }, [templateId])

  const includeOthers = template ? template.include_others : true
  const active = useMemo(
    () => activeBilmenRecipients(recipients || undefined, { includeOthers }),
    [recipients, includeOthers]
  )
  const rows = groupBilmenRecipients(active)
  const replyTo = settings?.reply_to || ''
  const cannotSend = !template || isBilmen || active.length === 0 || !subject.trim() || !body.trim()
  const mailtoUrl = cannotSend ? '#' : buildBilmenNoticeMailto(subject, body, active, replyTo)

  async function handleCreateDraft() {
    setDraftError('')
    setDraftResult(null)
    setDraftStep('draft')
    try {
      const result = await createTenantMailDraft({ templateId, subject, body })
      setDraftResult(result)
      setDraftStep('done')
    } catch (err) {
      setDraftError(err.message)
      setDraftStep('idle')
    }
  }

  if (templates.length === 0) {
    return (
      <p className="bilmen-undecided">
        雛型がありません。<Link to="/tenant-mail?tab=templates">雛型</Link>のタブで登録してください。
      </p>
    )
  }

  // レイアウト（2026-10-29 依頼）: 1行目＝雛型（右に返信先）→ 横幅いっぱいの区切り線 →
  // 左1/3＝件名・宛先（BCC）、右2/3＝本文。本文の領域をできるだけ広くとるため。
  // 宛先の無い有効テナントの警告はこの画面には出さない（「宛先・返信先」タブの一覧に「未登録」と出る）
  return (
    <div className="tenant-mail-compose">
      <div className="tenant-mail-compose-top">
        <div className="ui-field">
          <label htmlFor="tenant-mail-template">雛型</label>
          <select
            id="tenant-mail-template"
            className="ui-input"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            disabled={draftStep === 'draft'}
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.kind === 'bilmen' ? `【ビルメン】${t.name}` : t.name}
              </option>
            ))}
          </select>
        </div>
        {!isBilmen && (
          <div className="ui-field">
            <label>返信先</label>
            <input className="ui-input" value={replyTo || '（未設定：送信元のアドレスに返信されます）'} readOnly />
          </div>
        )}
      </div>
      <hr className="tenant-mail-divider" />

      {isBilmen ? (
        <p className="bilmen-undecided">
          この雛型は連絡票PDFを添付するため、<Link to="/bilmen">ビルメンテナンス管理</Link>の画面で月を選び、
          「テナントへ報知」から作成してください（件名・本文は「雛型」タブで直せます）。
        </p>
      ) : (
        <>
          <div className="tenant-mail-compose-main">
            <div className="tenant-mail-compose-side">
              <div className="ui-field">
                <label htmlFor="tenant-mail-subject">件名</label>
                <input
                  id="tenant-mail-subject"
                  className="ui-input"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </div>
              <section className="bilmen-notify-recipients" aria-label="宛先">
                <div className="bilmen-notify-recipients-inner">
                  <h3 className="bilmen-notify-recipients-title">宛先 {rows.length}件（BCC）</h3>
                  <p className="bilmen-notify-recipients-note">
                    今日の時点で退去済みのテナントを省いています。
                    {includeOthers ? 'その他の宛先も含みます。' : 'その他の宛先は含みません。'}
                  </p>
                  <ol className="bilmen-notify-recipient-list">
                    {rows.map((r, i) => (
                      <li key={r.key}>
                        <span className="bilmen-notify-recipient-no">{i + 1}</span>
                        <button
                          type="button"
                          className="bilmen-notify-recipient-name"
                          title={r.emails.join('\n')}
                          onClick={() => setOpenKey((k) => (k === r.key ? null : r.key))}
                        >
                          {r.name}
                        </button>
                        {openKey === r.key && <span className="bilmen-notify-recipient-mail">{r.emails.join(', ')}</span>}
                      </li>
                    ))}
                  </ol>
                </div>
              </section>
            </div>
            <div className="ui-field tenant-mail-body-field">
              <label htmlFor="tenant-mail-body">
                本文<span className="tenant-mail-label-note">（雛型を変更する場合は雛型タブから）</span>
              </label>
              <textarea
                id="tenant-mail-body"
                className="ui-textarea"
                rows={18}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </div>
          </div>

          {draftError && (
            <p className="dashboard-error dashboard-banner" role="alert">
              {draftError}
            </p>
          )}

          <p className="bilmen-notify-lead">下記の２つの方式のいずれかでメールを作成してください。</p>

          <div className="bilmen-notify-methods">
            <section className="bilmen-notify-method is-mailto">
              <div className="bilmen-notify-method-head">
                <h3 className="bilmen-notify-method-title">メールソフト方式</h3>
                <p className="bilmen-notify-method-sub">端末のメールソフトで作成</p>
              </div>
              <div className="bilmen-notify-method-body">
                <p className="bilmen-notify-method-note">宛先（BCC）・件名・本文が入った作成画面が開きます。</p>
                <div className="bilmen-notify-method-actions">
                  <a
                    className={`btn-primary${cannotSend ? ' is-disabled' : ''}`}
                    href={mailtoUrl}
                    aria-disabled={cannotSend}
                    onClick={(e) => {
                      if (cannotSend) e.preventDefault()
                    }}
                  >
                    メールを作成
                  </a>
                </div>
              </div>
            </section>

            <section className="bilmen-notify-method is-gmail">
              <div className="bilmen-notify-method-head">
                <h3 className="bilmen-notify-method-title">Gmail方式</h3>
                <p className="bilmen-notify-method-sub">共有アドレスに下書きを作成</p>
              </div>
              {draftStep === 'done' && draftResult ? (
                <div className="bilmen-notify-method-body" role="status">
                  <div className="bilmen-notify-method-actions">
                    <a className="btn-primary" href={draftResult.draft_url} target="_blank" rel="noreferrer">
                      Gmail で下書きを開く
                    </a>
                    <button type="button" className="btn-plain" onClick={handleCreateDraft} disabled={cannotSend}>
                      下書きをもう一度作成
                    </button>
                    <a className="bilmen-notify-sublink" href={draftResult.drafts_url} target="_blank" rel="noreferrer">
                      開かないときは下書きフォルダへ
                    </a>
                  </div>
                </div>
              ) : (
                <div className="bilmen-notify-method-body">
                  <p className="bilmen-notify-method-note">送信元は、eiwa.public@gmail.com となります。</p>
                  {replyTo && (
                    <p className="bilmen-notify-method-note is-muted">
                      本文の末尾に「ご返信は {replyTo} までお願いいたします。」を付けて作成します。
                    </p>
                  )}
                  <div className="bilmen-notify-method-actions">
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={handleCreateDraft}
                      disabled={cannotSend || draftStep === 'draft'}
                    >
                      {draftStep === 'draft' ? 'Gmail に登録中…' : 'Gmail に下書きを作成'}
                    </button>
                  </div>
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  )
}

// ---- 雛型 ----
const EMPTY_TEMPLATE = { name: '', subject: '', body: '', include_others: true, sort_order: '' }

function templateDraftOf(t) {
  return { name: t.name, subject: t.subject, body: t.body, include_others: t.include_others, sort_order: t.sort_order }
}

function TemplatesTab({ templates, setTemplates }) {
  const [editingId, setEditingId] = useState(null) // 'new' か雛型の id
  const [draft, setDraft] = useState(EMPTY_TEMPLATE)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  function startEdit(t) {
    setError('')
    setInfo('')
    setEditingId(t ? t.id : 'new')
    setDraft(t ? templateDraftOf(t) : EMPTY_TEMPLATE)
  }

  async function handleSave() {
    setSaving(true)
    setError('')
    setInfo('')
    try {
      const payload = { ...draft, sort_order: draft.sort_order === '' ? null : draft.sort_order }
      if (editingId === 'new') {
        const created = await createTenantMailTemplate(payload)
        setTemplates((prev) => [...prev, created].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'ja')))
      } else {
        const saved = await updateTenantMailTemplate(editingId, payload)
        setTemplates((prev) => prev.map((t) => (t.id === saved.id ? saved : t)))
      }
      setInfo(`「${draft.name}」を保存しました。`)
      setEditingId(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(t) {
    setError('')
    setInfo('')
    try {
      await deleteTenantMailTemplate(t.id)
      setTemplates((prev) => prev.filter((x) => x.id !== t.id))
      if (editingId === t.id) setEditingId(null)
    } catch (err) {
      setError(err.message)
    }
  }

  const editingBilmen = templates.find((t) => t.id === editingId)?.kind === 'bilmen'

  const editor = (
    <div className="tenant-mail-template-editor">
      <div className="ui-field">
        <label htmlFor="tenant-mail-tpl-name">雛型名</label>
        <input
          id="tenant-mail-tpl-name"
          className="ui-input"
          value={draft.name}
          placeholder="例: 停電のお知らせ"
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
        />
      </div>
      <div className="ui-field">
        <label htmlFor="tenant-mail-tpl-subject">件名</label>
        <input
          id="tenant-mail-tpl-subject"
          className="ui-input"
          value={draft.subject}
          onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))}
        />
      </div>
      <div className="ui-field">
        <label htmlFor="tenant-mail-tpl-body">本文</label>
        <textarea
          id="tenant-mail-tpl-body"
          className="ui-textarea"
          rows={10}
          value={draft.body}
          onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
        />
        <p className="ui-note">
          使える変数:{' '}
          {editingBilmen ? (
            <>
              <code>%対象年月%</code>（例: 2026年9月度）／ <code>%建物名%</code>／ <code>%作業件数%</code>（報知対象の件数）
            </>
          ) : (
            TENANT_MAIL_VARIABLES.map((v, i) => (
              <span key={v.key}>
                {i > 0 && '／ '}
                <code>{v.key}</code>（{v.note}）
              </span>
            ))
          )}
        </p>
      </div>
      <div className="tenant-mail-template-options">
        <label className="tenant-mail-check">
          <input
            type="checkbox"
            checked={draft.include_others}
            onChange={(e) => setDraft((d) => ({ ...d, include_others: e.target.checked }))}
          />
          その他の宛先（小泉産業様のご担当者・栄和ML など）も BCC に入れる
        </label>
        <label className="tenant-mail-sort">
          表示順
          <input
            className="ui-input is-compact"
            type="number"
            inputMode="numeric"
            value={draft.sort_order}
            onChange={(e) => setDraft((d) => ({ ...d, sort_order: e.target.value }))}
          />
        </label>
      </div>
      <div className="bilmen-generate-actions">
        <button type="button" className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
        <button type="button" className="btn-plain" onClick={() => setEditingId(null)} disabled={saving}>
          やめる
        </button>
      </div>
    </div>
  )

  return (
    <>
      {error && (
        <p className="dashboard-error dashboard-banner" role="alert">
          {error}
        </p>
      )}
      {info && <p className="dashboard-banner">{info}</p>}

      <section className="bilmen-fieldset">
        <div className="tenant-mail-section-head">
          <h2 className="ui-page-title">雛型（{templates.length}件）</h2>
          {editingId !== 'new' && (
            <button type="button" className="btn-primary" onClick={() => startEdit(null)}>
              ＋ 雛型を追加
            </button>
          )}
        </div>
        {editingId === 'new' && editor}
        <ul className="tenant-mail-template-list">
          {templates.map((t) => (
            <li key={t.id} className="tenant-mail-template-item">
              {editingId === t.id ? (
                editor
              ) : (
                <>
                  <div className="tenant-mail-template-summary">
                    <p className="tenant-mail-template-name">
                      {t.kind === 'bilmen' && <span className="tenant-mail-badge">ビルメン</span>}
                      {t.name}
                    </p>
                    <p className="tenant-mail-template-subject">件名: {t.subject}</p>
                    <p className="tenant-mail-template-meta">
                      {t.include_others ? 'その他の宛先も含む' : 'テナントのみ'}
                      {t.kind === 'bilmen' && '・作成はビルメンテナンス管理の「テナントへ報知」から（連絡票PDFを添付）'}
                    </p>
                  </div>
                  <div className="bilmen-generate-actions">
                    <button type="button" className="btn-plain" onClick={() => startEdit(t)} disabled={editingId !== null}>
                      修正
                    </button>
                    {t.kind !== 'bilmen' && (
                      <ConfirmDeleteButton label={`${t.name} を削除`} onConfirm={() => handleDelete(t)} />
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}

// ---- 宛先・返信先（旧 /bilmen/mail「メール設定」の宛先・返信先部分。docs/bilmen-plan.md 7-3・13-19） ----
// テナントの宛先はテナントマスタの「案内メールの宛先」（未退去のテナントだけ。ここでは見るだけ）。
// ここで直すのは、テナントではない「その他の宛先」と返信先だけ
const EMPTY_RECIPIENT = { name: '', email: '', note: '', disabled: false }

function RecipientsTab({ settings, setSettings, recipients, setRecipients }) {
  const [replyTo, setReplyTo] = useState(settings?.reply_to || '')
  const [savingReplyTo, setSavingReplyTo] = useState(false)
  const [drafts, setDrafts] = useState({})
  const [newRecipient, setNewRecipient] = useState(EMPTY_RECIPIENT)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  const others = recipients?.others || []
  const tenantRecipients = recipients?.tenants || []
  const missing = recipients?.missing || []
  const setOthers = (fn) => setRecipients((prev) => ({ ...prev, others: fn(prev.others) }))

  async function handleSaveReplyTo() {
    setSavingReplyTo(true)
    setError('')
    setInfo('')
    try {
      const saved = await updateBilmenMailSettings({ reply_to: replyTo })
      setReplyTo(saved.reply_to || '')
      setSettings((prev) => ({ ...prev, reply_to: saved.reply_to || null }))
      setInfo('返信先を保存しました。')
    } catch (err) {
      setError(err.message)
    } finally {
      setSavingReplyTo(false)
    }
  }

  function draftFor(r) {
    return drafts[r.id] || { name: r.name, email: r.email, note: r.note || '', disabled: r.disabled }
  }

  function updateDraft(id, patch) {
    setDrafts((prev) => {
      const base = prev[id] || draftFor(others.find((r) => r.id === id))
      return { ...prev, [id]: { ...base, ...patch } }
    })
  }

  async function handleSaveRecipient(id) {
    setError('')
    try {
      const saved = await updateBilmenMailRecipient(id, draftFor(others.find((r) => r.id === id)))
      setOthers((prev) => prev.map((r) => (r.id === id ? saved : r)))
      setDrafts((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleDeleteRecipient(id) {
    setError('')
    try {
      await deleteBilmenMailRecipient(id)
      setOthers((prev) => prev.filter((r) => r.id !== id))
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleAddRecipient() {
    if (!newRecipient.name.trim() || !newRecipient.email.trim()) {
      setError('宛先名とメールアドレスは必須です')
      return
    }
    setAdding(true)
    setError('')
    try {
      const created = await createBilmenMailRecipient(newRecipient)
      setOthers((prev) => [...prev, created])
      setNewRecipient(EMPTY_RECIPIENT)
    } catch (err) {
      setError(err.message)
    } finally {
      setAdding(false)
    }
  }

  return (
    <>
      {error && (
        <p className="dashboard-error dashboard-banner" role="alert">
          {error}
        </p>
      )}
      {info && <p className="dashboard-banner">{info}</p>}

      <section className="bilmen-fieldset">
        <h2 className="ui-page-title">返信先</h2>
        {/* テナントが「返信」したときの宛先。全雛型（ビルメンの案内メールを含む）で共通。
            方式A（Gmail下書き）・方式B（mailto:）の両方で Reply-To に入る */}
        <div className="ui-field">
          <label htmlFor="tenant-mail-reply-to">返信先アドレス</label>
          <input
            id="tenant-mail-reply-to"
            className="ui-input"
            type="email"
            inputMode="email"
            placeholder="bkb@eiwa-up.com"
            value={replyTo}
            onChange={(e) => setReplyTo(e.target.value)}
          />
          <p className="ui-note">テナント様がメールに「返信」したときの宛先になります（空欄なら送信元に返信されます）。</p>
        </div>
        <button type="button" className="btn-primary" onClick={handleSaveReplyTo} disabled={savingReplyTo}>
          {savingReplyTo ? '保存中…' : '返信先を保存'}
        </button>
      </section>

      <section className="bilmen-fieldset">
        <h2 className="ui-page-title">テナントの宛先（{tenantRecipients.length}件）</h2>
        <p className="ui-note">
          <Link to="/equipment/tenants">テナントマスタ</Link>で「案内メールの宛先」を登録した、未退去のテナントです。
          追加・修正はテナントマスタで行ってください（退去日を過ぎたテナントには送りません）。
        </p>
        <div className="ui-table-wrap">
          <table className="ui-table bilmen-mail-recipients-table">
            <thead>
              <tr>
                <th>階</th>
                <th>テナント</th>
                <th>メールアドレス</th>
              </tr>
            </thead>
            <tbody>
              {tenantRecipients.length === 0 ? (
                <tr>
                  <td colSpan={3} className="ui-note">
                    案内メールの宛先を登録したテナントがありません。
                  </td>
                </tr>
              ) : (
                tenantRecipients.map((r) => (
                  <tr key={`${r.tenant_id}-${r.email}`}>
                    <td>{floorLabel(r.floor)}</td>
                    <td>{r.tenant_name}</td>
                    <td>{r.email}</td>
                  </tr>
                ))
              )}
              {missing.map((t) => (
                <tr key={`missing-${t.tenant_id}`} className="is-disabled">
                  <td>{floorLabel(t.floor)}</td>
                  <td>{t.tenant_name}</td>
                  <td className="tenant-mail-missing">未登録（送られません）</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="bilmen-fieldset">
        <h2 className="ui-page-title">その他の宛先</h2>
        <p className="ui-note">
          テナントではない宛先（小泉産業様のご担当者・栄和ML など）です。雛型ごとに入れるかどうかを選べます。
        </p>
        <div className="ui-table-wrap">
          <table className="ui-table bilmen-mail-recipients-table">
            <thead>
              <tr>
                <th>宛先名</th>
                <th>メールアドレス</th>
                <th>備考</th>
                <th>有効</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {others.map((r) => {
                const draft = draftFor(r)
                const dirty = Boolean(drafts[r.id])
                return (
                  <tr key={r.id} className={r.disabled ? 'is-disabled' : ''}>
                    <td>
                      <input
                        className="ui-input is-compact"
                        value={draft.name}
                        onChange={(e) => updateDraft(r.id, { name: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className="ui-input is-compact"
                        value={draft.email}
                        onChange={(e) => updateDraft(r.id, { email: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className="ui-input is-compact"
                        value={draft.note}
                        onChange={(e) => updateDraft(r.id, { note: e.target.value })}
                      />
                    </td>
                    <td className="bilmen-check-cell">
                      <input
                        type="checkbox"
                        checked={!draft.disabled}
                        onChange={(e) => updateDraft(r.id, { disabled: !e.target.checked })}
                        aria-label={`${r.name} を有効にする`}
                      />
                    </td>
                    <td>
                      <div className="bilmen-generate-actions">
                        {dirty && (
                          <button type="button" className="btn-plain" onClick={() => handleSaveRecipient(r.id)}>
                            保存
                          </button>
                        )}
                        <ConfirmDeleteButton label={`${r.name} を削除`} onConfirm={() => handleDeleteRecipient(r.id)} />
                      </div>
                    </td>
                  </tr>
                )
              })}
              <tr>
                <td>
                  <input
                    className="ui-input is-compact"
                    value={newRecipient.name}
                    placeholder="宛先名"
                    onChange={(e) => setNewRecipient((prev) => ({ ...prev, name: e.target.value }))}
                  />
                </td>
                <td>
                  <input
                    className="ui-input is-compact"
                    value={newRecipient.email}
                    placeholder="メールアドレス"
                    onChange={(e) => setNewRecipient((prev) => ({ ...prev, email: e.target.value }))}
                  />
                </td>
                <td>
                  <input
                    className="ui-input is-compact"
                    value={newRecipient.note}
                    placeholder="備考"
                    onChange={(e) => setNewRecipient((prev) => ({ ...prev, note: e.target.value }))}
                  />
                </td>
                <td />
                <td>
                  <button type="button" className="btn-primary" onClick={handleAddRecipient} disabled={adding}>
                    {adding ? '追加中…' : '←追加'}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}
