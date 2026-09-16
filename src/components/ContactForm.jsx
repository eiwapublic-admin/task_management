import { useState } from 'react'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import Combobox from './Combobox'
import ConfirmDeleteButton from './ConfirmDeleteButton'
import { IconPhone, IconMobile, IconMail, IconGlobe } from './Icons'
import { createContact, updateContact, deleteContact, buildContactMailto, toExternalUrl } from '../lib/contacts'

// 連絡帳の追加・編集モーダル（2026-08-31〜）。EquipmentItemForm・DocumentTemplateFormと同じ
// ui-overlay/ui-modalの標準レイアウトに合わせる。
//
// 2026-09-16、電話・メール・ホームページの各項目の**見出しの右に発信アイコン**を足した（依頼）。
// 一覧の行には元から同じ導線があるが、連絡先を開いて中身を見ている状態からそのまま
// 掛けられるようにしたもの。リンク先は保存済みの値ではなく**今入力されている値**から作るので、
// 書きかけの番号でもそのまま試せる（保存は不要）。値が空の項目にはアイコンを出さない。
export default function ContactForm({ existing, categories, assignees, onClose, onSaved, onDeleted }) {
  useBodyScrollLock()

  const [companyName, setCompanyName] = useState(existing?.company_name || '')
  const [businessCategory, setBusinessCategory] = useState(existing?.business_category || '')
  const [contactPerson, setContactPerson] = useState(existing?.contact_person || '')
  const [staffName, setStaffName] = useState(existing?.staff_name || '')
  const [companyPhone, setCompanyPhone] = useState(existing?.company_phone || '')
  const [mobilePhone, setMobilePhone] = useState(existing?.mobile_phone || '')
  const [emailTo, setEmailTo] = useState(existing?.email_to || '')
  const [emailCc, setEmailCc] = useState(existing?.email_cc || '')
  const [websiteUrl, setWebsiteUrl] = useState(existing?.website_url || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // 発信リンクは保存済みの値ではなく今入力されている値から作る（書きかけでも試せる）
  const mailto = buildContactMailto({ email_to: emailTo, email_cc: emailCc })
  const externalUrl = toExternalUrl(websiteUrl)

  async function handleSave() {
    setError('')
    if (!companyName.trim()) return setError('会社名は必須です')

    setSaving(true)
    try {
      const payload = {
        company_name: companyName.trim(),
        business_category: businessCategory.trim() || null,
        contact_person: contactPerson.trim() || null,
        staff_name: staffName || null,
        company_phone: companyPhone.trim() || null,
        mobile_phone: mobilePhone.trim() || null,
        email_to: emailTo.trim() || null,
        email_cc: emailCc.trim() || null,
        website_url: websiteUrl.trim() || null,
      }
      const saved = existing ? await updateContact(existing.id, payload) : await createContact(payload)
      onSaved(saved)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  async function handleDelete() {
    try {
      await deleteContact(existing.id)
      onDeleted(existing.id)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="ui-overlay is-nested" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="ui-modal is-sm" onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h3 className="ui-modal-title">{existing ? existing.company_name : '連絡先を追加'}</h3>
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

          <label className="ui-field">
            <span>会社名</span>
            <input
              type="text"
              className="ui-input"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
          </label>

          <label className="ui-field">
            <span>業務分類</span>
            <Combobox
              value={businessCategory}
              onChange={setBusinessCategory}
              options={categories}
              placeholder="例: リニューアルプレート など（未整理でも可）"
            />
          </label>

          <label className="ui-field">
            <span>顧客担当者名</span>
            <input
              type="text"
              className="ui-input"
              value={contactPerson}
              onChange={(e) => setContactPerson(e.target.value)}
            />
          </label>

          <label className="ui-field">
            <span>当社の主担当者</span>
            <select className="ui-select" value={staffName} onChange={(e) => setStaffName(e.target.value)}>
              <option value="">（未設定）</option>
              {assignees.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>

          <div className="report-fields">
            <div className="ui-field">
              <div className="contact-field-head">
                <label htmlFor="contact-company-phone">会社電話番号</label>
                {companyPhone.trim() && (
                  <a
                    className="icon-btn-phone"
                    href={`tel:${companyPhone.trim()}`}
                    aria-label={`会社に電話（${companyPhone.trim()}）`}
                    title={`会社に電話（${companyPhone.trim()}）`}
                  >
                    <IconPhone size={18} />
                  </a>
                )}
              </div>
              <input
                id="contact-company-phone"
                type="tel"
                className="ui-input"
                value={companyPhone}
                onChange={(e) => setCompanyPhone(e.target.value)}
              />
            </div>
            <div className="ui-field">
              <div className="contact-field-head">
                <label htmlFor="contact-mobile-phone">携帯電話番号</label>
                {mobilePhone.trim() && (
                  <a
                    className="icon-btn-phone"
                    href={`tel:${mobilePhone.trim()}`}
                    aria-label={`携帯に電話（${mobilePhone.trim()}）`}
                    title={`携帯に電話（${mobilePhone.trim()}）`}
                  >
                    <IconMobile size={18} />
                  </a>
                )}
              </div>
              <input
                id="contact-mobile-phone"
                type="tel"
                className="ui-input"
                value={mobilePhone}
                onChange={(e) => setMobilePhone(e.target.value)}
              />
            </div>
          </div>

          {/* TO・CCは別々の項目だが、メール作成は1つの操作なので見出しは「メール」1つにまとめ、
              アイコンもそこに置く（TOに送りCCを自動で付ける、という関係が見た目で分かる） */}
          <div className="ui-field">
            <div className="contact-field-head">
              <span>メール</span>
              {mailto && (
                <a
                  className="icon-btn-mail"
                  href={mailto}
                  aria-label={`メールを作成（TO: ${emailTo.trim()}）`}
                  title={emailCc.trim() ? `メールを作成（TO: ${emailTo.trim()} / CC: ${emailCc.trim()}）` : `メールを作成（TO: ${emailTo.trim()}）`}
                >
                  <IconMail size={18} />
                </a>
              )}
            </div>
            <div className="contact-mail-row">
              <label className="contact-mail-prefix" htmlFor="contact-email-to">
                TO:
              </label>
              <input
                id="contact-email-to"
                type="email"
                className="ui-input"
                value={emailTo}
                onChange={(e) => setEmailTo(e.target.value)}
              />
            </div>
            <div className="contact-mail-row">
              <label className="contact-mail-prefix" htmlFor="contact-email-cc">
                CC:
              </label>
              <input
                id="contact-email-cc"
                type="text"
                className="ui-input"
                placeholder="定例で付ける宛先（カンマ区切りで複数可）"
                value={emailCc}
                onChange={(e) => setEmailCc(e.target.value)}
              />
            </div>
          </div>

          <div className="ui-field">
            <div className="contact-field-head">
              <label htmlFor="contact-website-url">ホームページアドレス</label>
              {externalUrl && (
                <a
                  className="icon-btn-globe"
                  href={externalUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="ホームページを開く"
                  title={`ホームページを開く（${externalUrl}）`}
                >
                  <IconGlobe size={18} />
                </a>
              )}
            </div>
            <input
              id="contact-website-url"
              type="text"
              className="ui-input"
              placeholder="https://…"
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
            />
          </div>
        </div>

        <div className="ui-modal-foot">
          <div className="ui-modal-foot-start">
            {existing && <ConfirmDeleteButton onConfirm={handleDelete} label="この連絡先を削除" size={22} />}
          </div>
          <div className="ui-modal-foot-end">
            <button type="button" className="btn-plain" onClick={onClose}>
              キャンセル
            </button>
            <button type="button" className="btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? '保存中…' : '保存する'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
