import { useState } from 'react'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import { TENANT_PROFILE_FIELDS, updateMeterTenant } from '../lib/meter'

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

// 検針のテナント（備品と共有のテナントマスタ）の修正（2026-10-20〜。docs/meter-plan.md 3-4）。
// FileMaker のテナントマスタの項目をそのまま持つ。防火・連絡先の項目（基本情報）は社員だけが見られる。
// 並行運用の間は、名称・略称・階・備考が FileMaker からの同期で上書きされる
export default function MeterTenantForm({ tenant, onClose, onSaved }) {
  useBodyScrollLock()
  const [form, setForm] = useState(() => ({
    name: tenant.name || '',
    short_name: tenant.short_name || '',
    floor: tenant.floor || '',
    note: tenant.note || '',
    moved_out: !!tenant.moved_out,
    moved_in_on: tenant.moved_in_on || '',
    first_month_billable: !!tenant.first_month_billable,
  }))
  const [profile, setProfile] = useState(() => {
    const p = { ...(tenant.profile || {}) }
    const contacts = [...(p.emergency_contacts || [])]
    while (contacts.length < 3) contacts.push({ ...EMPTY_CONTACT })
    p.emergency_contacts = contacts
    return p
  })
  const [saving, setSaving] = useState(false)
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
    if (!form.name.trim()) return setError('正式名称を入力してください')
    setSaving(true)
    try {
      const saved = await updateMeterTenant({ id: tenant.id, ...form, profile })
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
          <h3 className="ui-modal-title">テナントの修正（{tenant.billing_code || 'コードなし'}）</h3>
          <button type="button" className="icon-btn-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>
        <div className="ui-modal-body is-stacked">
          <p className="ui-note">
            FileMaker と並行して使っている間は、正式名称・略称・階・備考は FileMaker からの同期で上書きされます。
          </p>
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
          <div className="ui-field-row">
            <label className="ui-field">
              <span>階</span>
              <input className="ui-input" value={form.floor} onChange={set('floor')} placeholder="B・1〜7（共用エリアは空）" />
            </label>
            <label className="ui-field">
              <span>入居年月日</span>
              <input type="date" className="ui-input" value={form.moved_in_on} onChange={set('moved_in_on')} />
            </label>
          </div>
          <div className="meter-switch-row">
            <Switch
              checked={form.first_month_billable}
              onChange={(v) => setForm((f) => ({ ...f, first_month_billable: v }))}
              label="初月無料にしない"
            />
            <Switch checked={form.moved_out} onChange={(v) => setForm((f) => ({ ...f, moved_out: v }))} label="退去済み" />
          </div>
          <label className="ui-field">
            <span>検針に関する備考</span>
            <textarea className="ui-textarea" rows={2} value={form.note} onChange={set('note')} />
          </label>

          <h4 className="meter-form-section">基本情報（社員のみ）</h4>
          <div className="meter-form-grid">
            {TENANT_PROFILE_FIELDS.map((f) => (
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
