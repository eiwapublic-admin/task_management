import { useState } from 'react'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import { TENANT_PROFILE_FIELDS, saveMeterTenant } from '../lib/meter'
import { jstToday } from '../lib/tenants'
import MeterHistoryList from './MeterHistoryList'

function Switch({ checked, onChange, label }) {
  return (
    <label className="switch-field">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track">
        <span className="switch-thumb" />
      </span>
      <span className="switch-label">{label}</span>
    </label>
  )
}

const EMPTY_CONTACT = { name: '', kana: '', phone: '', mobile: '' }

// テナントマスタ（備品と検針で共有）の追加・修正（2026-10-20〜。docs/meter-plan.md 3-4）。tenant が null なら追加。
// FileMaker のテナントマスタの項目をそのまま持つ。防火・連絡先の項目（基本情報）は社員だけが見られる。
// 並行運用の間は、名称・略称・階・備考が FileMaker からの同期で上書きされる。
// 退去は退去日で表す（前もって入れておけば、その日が来るまでは入居中のまま）。
// 請求先コードは FileMaker からの同期の突き合わせに使うので、FileMaker から来たテナントでは変えられない
export default function MeterTenantForm({ tenant: original, onClose, onSaved, onReverted }) {
  useBodyScrollLock()
  const isNew = !original
  const tenant = original || {}
  const codeLocked = !isNew && tenant.source === 'filemaker'
  // 退去日の無い退去済み（2026-10-20 より前に FileMaker で退去になったもの）
  const legacyMovedOut = !!tenant.moved_out && !tenant.moved_out_on
  const [form, setForm] = useState(() => ({
    billing_code: tenant.billing_code || '',
    name: tenant.name || '',
    short_name: tenant.short_name || '',
    floor: tenant.floor || '',
    note: tenant.note || '',
    moved_out: legacyMovedOut,
    moved_out_on: tenant.moved_out_on || '',
    moved_in_on: tenant.moved_in_on || '',
    notice_emails: (tenant.notice_emails || []).join(', '),
    first_month_billable: isNew ? true : !!tenant.first_month_billable, // 新規は「初月無料にしない」（FileMaker の現在の既定）
  }))
  const [profile, setProfile] = useState(() => {
    const p = { ...(tenant.profile || {}) }
    const contacts = [...(p.emergency_contacts || [])]
    while (contacts.length < 3) contacts.push({ ...EMPTY_CONTACT })
    p.emergency_contacts = contacts
    return p
  })
  const [saving, setSaving] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [error, setError] = useState('')

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))
  const setP = (key) => (e) => setProfile((p) => ({ ...p, [key]: e.target.value }))
  const setContact = (i, key) => (e) =>
    setProfile((p) => ({
      ...p,
      emergency_contacts: p.emergency_contacts.map((c, j) => (j === i ? { ...c, [key]: e.target.value } : c)),
    }))

  async function handleSave() {
    setError('')
    if (!form.billing_code.trim()) return setError('請求先コードを入力してください')
    if (!form.name.trim()) return setError('正式名称を入力してください')
    setSaving(true)
    try {
      const { billing_code: code, ...rest } = form
      const saved = await saveMeterTenant({
        ...(isNew ? {} : { id: tenant.id }),
        ...(codeLocked ? {} : { billing_code: code }),
        ...rest,
        profile,
      })
      onSaved(saved)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <div className="ui-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="ui-modal is-lg" onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h3 className="ui-modal-title">{isNew ? 'テナントの追加' : `テナントの修正（${tenant.billing_code || 'コードなし'}）`}</h3>
          <button type="button" className="icon-btn-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>
        <div className="ui-modal-body is-stacked">
          <p className="ui-note">FileMaker と並行して使っている間は、正式名称・略称・階・備考は FileMaker からの同期で上書きされます。</p>
          <div className="meter-form-grid tenant-form-head">
            <label className="ui-field">
              <span>請求先コード</span>
              <input
                className="ui-input"
                value={form.billing_code}
                onChange={set('billing_code')}
                disabled={codeLocked}
                title={codeLocked ? 'FileMaker から来たテナントの請求先コードは変えられません' : undefined}
              />
            </label>
            <label className="ui-field">
              <span>階</span>
              <input className="ui-input" value={form.floor} onChange={set('floor')} placeholder="B・1〜7（共用は空）" />
            </label>
            <label className="ui-field">
              <span>入居年月日</span>
              <input type="date" className="ui-input" value={form.moved_in_on} onChange={set('moved_in_on')} />
            </label>
            <label className="ui-field">
              <span>退去日</span>
              <input type="date" className="ui-input" value={form.moved_out_on} onChange={set('moved_out_on')} />
            </label>
          </div>
          <p className="ui-note">
            {form.moved_out_on
              ? form.moved_out_on > jstToday()
                ? `退去予定です。${form.moved_out_on.replaceAll('-', '/')} になるまでは入居中として扱います。`
                : 'この日から退去済みとして扱います。'
              : '退去日は前もって入れておけます。その日になると退去済みになり、一覧の各階の末尾に灰色で出ます。'}
          </p>
          {legacyMovedOut && !form.moved_out_on && (
            <label className="meter-check">
              <input type="checkbox" checked={form.moved_out} onChange={(e) => setForm((f) => ({ ...f, moved_out: e.target.checked }))} />
              退去済み（退去日の記録なし）。外すと入居中に戻ります
            </label>
          )}
          <div className="ui-field-row">
            <label className="ui-field">
              <span>正式名称</span>
              <input className="ui-input" value={form.name} onChange={set('name')} />
            </label>
            <label className="ui-field">
              <span>略称</span>
              <input className="ui-input" value={form.short_name} onChange={set('short_name')} />
            </label>
          </div>
          <div className="meter-switch-row">
            <Switch
              checked={form.first_month_billable}
              onChange={(v) => setForm((f) => ({ ...f, first_month_billable: v }))}
              label="初月無料にしない"
            />
          </div>
          <label className="ui-field">
            <span>案内メールの宛先</span>
            <input
              type="text"
              className="ui-input"
              inputMode="email"
              value={form.notice_emails}
              onChange={set('notice_emails')}
              placeholder="複数のときは「,」で区切る"
            />
          </label>
          <p className="ui-note">ビルメンの案内メールを送るアドレスです。未退去の間だけ送ります。</p>

          <h4 className="meter-form-section">基本情報（社員のみ）</h4>
          <div className="meter-form-grid">
            {TENANT_PROFILE_FIELDS.filter((f) => !f.hidden && !f.wide).map((f) => (
              <label key={f.key} className="ui-field">
                <span>{f.label}</span>
                <input
                  type={f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text'}
                  inputMode={f.type === 'number' ? 'numeric' : undefined}
                  className="ui-input"
                  value={profile[f.key] ?? ''}
                  onChange={setP(f.key)}
                />
              </label>
            ))}
          </div>

          <h4 className="meter-form-section">緊急連絡先</h4>
          {profile.emergency_contacts.map((c, i) => (
            <div key={i} className="meter-form-grid is-contact">
              <label className="ui-field">
                <span>氏名 {i + 1}</span>
                <input className="ui-input" value={c.name || ''} onChange={setContact(i, 'name')} />
              </label>
              <label className="ui-field">
                <span>フリガナ</span>
                <input className="ui-input" value={c.kana || ''} onChange={setContact(i, 'kana')} />
              </label>
              <label className="ui-field">
                <span>電話</span>
                <input className="ui-input" inputMode="tel" value={c.phone || ''} onChange={setContact(i, 'phone')} />
              </label>
              <label className="ui-field">
                <span>携帯</span>
                <input className="ui-input" inputMode="tel" value={c.mobile || ''} onChange={setContact(i, 'mobile')} />
              </label>
            </div>
          ))}
          {TENANT_PROFILE_FIELDS.filter((f) => f.wide).map((f) => (
            <label key={f.key} className="ui-field">
              <span>{f.label}（社員のみ）</span>
              <textarea className="ui-textarea" rows={2} value={profile[f.key] ?? ''} onChange={setP(f.key)} />
            </label>
          ))}
          <label className="ui-field">
            <span>備考</span>
            <textarea className="ui-textarea" rows={2} value={form.note} onChange={set('note')} />
          </label>
          {!isNew && (
            <details className="meter-form-history" onToggle={(e) => setHistoryOpen(e.currentTarget.open)}>
              <summary>このテナントの変更履歴</summary>
              {historyOpen && <MeterHistoryList table="equipment_tenants" rowKey={tenant.id} onReverted={onReverted} limit={50} />}
            </details>
          )}
          {error && <p className="ui-note is-danger">{error}</p>}
        </div>
        <div className="ui-modal-foot">
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
