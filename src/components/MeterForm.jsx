import { useMemo, useState } from 'react'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import { saveMeter } from '../lib/meter'

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

const toText = (v) => (v == null ? '' : String(v))
const toNum = (v) => (String(v).trim() === '' ? null : Number(v))

// メータ（FileMaker のメータマスタ）の追加・修正（2026-10-20〜。docs/meter-plan.md 4章）。
// メータ番号はバーコード（Code39 `*メータ番号*`）の中身なので、変えるとラベルの貼り替えが要る
export default function MeterForm({ meter, tenants, onClose, onSaved }) {
  useBodyScrollLock()
  const [form, setForm] = useState(() => ({
    meter_no: toText(meter?.meter_no),
    room_no: toText(meter?.room_no),
    tenant_id: meter?.tenant_id || '',
    seq: toText(meter?.seq),
    floor: toText(meter?.floor),
    room_name: toText(meter?.room_name),
    detail_note: toText(meter?.detail_note),
    seal_label: toText(meter?.seal_label),
    kind: meter ? meter.kind || '' : '電気',
    sort_order: toText(meter?.sort_order),
    digits: toText(meter?.digits),
    max_value: toText(meter?.max_value),
    expires_on: toText(meter?.expires_on),
    area_m2: toText(meter?.area_m2),
    area_tsubo: toText(meter?.area_tsubo),
    oa_ratio: toText(meter?.oa_ratio),
    note: toText(meter?.note),
    measured: !!meter?.measured,
    oa_share: !!meter?.oa_share,
    is_oa_meter: !!meter?.is_oa_meter,
    removed: !!meter?.removed,
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // 退去済みのテナントは、いま割り当たっているときだけ選択肢に出す
  const tenantOptions = useMemo(
    () => tenants.filter((t) => !t.moved_out || t.id === meter?.tenant_id),
    [tenants, meter]
  )

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))
  const setFlag = (key) => (v) => setForm((f) => ({ ...f, [key]: v }))

  async function handleSave() {
    setError('')
    if (!form.meter_no.trim()) return setError('メータ番号を入力してください')
    setSaving(true)
    try {
      const saved = await saveMeter({
        ...(meter?.id ? { id: meter.id } : {}),
        ...form,
        tenant_id: form.tenant_id || null,
        kind: form.kind || null,
        seq: toNum(form.seq),
        sort_order: toNum(form.sort_order),
        digits: toNum(form.digits),
        max_value: toNum(form.max_value),
        area_m2: toNum(form.area_m2),
        area_tsubo: toNum(form.area_tsubo),
        oa_ratio: toNum(form.oa_ratio),
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
          <h3 className="ui-modal-title">{meter ? `メータ ${meter.meter_no} の修正` : 'メータの追加'}</h3>
          <button type="button" className="icon-btn-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>
        <div className="ui-modal-body is-stacked">
          <div className="meter-form-grid">
            <label className="ui-field">
              <span>メータ番号（バーコード）</span>
              <input className="ui-input" value={form.meter_no} onChange={set('meter_no')} placeholder="11-A" />
            </label>
            <label className="ui-field">
              <span>部屋番号</span>
              <input className="ui-input" value={form.room_no} onChange={set('room_no')} />
            </label>
            <label className="ui-field">
              <span>検針内容</span>
              <select className="ui-select" value={form.kind} onChange={set('kind')}>
                <option value="電気">電気</option>
                <option value="ガス">ガス</option>
                <option value="水道">水道</option>
                <option value="">（検針しない）</option>
              </select>
            </label>
            <label className="ui-field is-wide">
              <span>テナント（請求先）</span>
              <select className="ui-select" value={form.tenant_id} onChange={set('tenant_id')}>
                <option value="">（空室・未割当）</option>
                {tenantOptions.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.billing_code || '—'} {t.short_name || t.name}
                    {t.moved_out ? '（退去済み）' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="ui-field">
              <span>テナント内連番</span>
              <input className="ui-input" inputMode="numeric" value={form.seq} onChange={set('seq')} />
            </label>
            <label className="ui-field">
              <span>階</span>
              <input className="ui-input" value={form.floor} onChange={set('floor')} placeholder="B・1〜7" />
            </label>
            <label className="ui-field">
              <span>貸室名</span>
              <input className="ui-input" value={form.room_name} onChange={set('room_name')} />
            </label>
            <label className="ui-field">
              <span>請求明細補足</span>
              <input className="ui-input" value={form.detail_note} onChange={set('detail_note')} placeholder="21号室" />
            </label>
            <label className="ui-field">
              <span>メータシール表記</span>
              <input className="ui-input" value={form.seal_label} onChange={set('seal_label')} />
            </label>
            <label className="ui-field">
              <span>表示順</span>
              <input className="ui-input" inputMode="numeric" value={form.sort_order} onChange={set('sort_order')} />
            </label>
            <label className="ui-field">
              <span>メーター桁数</span>
              <input className="ui-input" inputMode="numeric" value={form.digits} onChange={set('digits')} />
            </label>
            <label className="ui-field">
              <span>メーター最大値</span>
              <input className="ui-input" inputMode="numeric" value={form.max_value} onChange={set('max_value')} />
            </label>
            <label className="ui-field">
              <span>有効期限</span>
              <input type="date" className="ui-input" value={form.expires_on} onChange={set('expires_on')} />
            </label>
            <label className="ui-field">
              <span>部屋面積（㎡）</span>
              <input className="ui-input" inputMode="decimal" value={form.area_m2} onChange={set('area_m2')} />
            </label>
            <label className="ui-field">
              <span>部屋面積（坪）</span>
              <input className="ui-input" inputMode="decimal" value={form.area_tsubo} onChange={set('area_tsubo')} />
            </label>
            <label className="ui-field">
              <span>外調機電気量の按分比率</span>
              <input className="ui-input" inputMode="decimal" value={form.oa_ratio} onChange={set('oa_ratio')} placeholder="0.0119" />
            </label>
          </div>
          <div className="meter-switch-row">
            <Switch checked={form.measured} onChange={setFlag('measured')} label="計測対象" />
            <Switch checked={form.oa_share} onChange={setFlag('oa_share')} label="外調機電気量を按分する" />
            <Switch checked={form.is_oa_meter} onChange={setFlag('is_oa_meter')} label="外調機メータ" />
            <Switch checked={form.removed} onChange={setFlag('removed')} label="検針機撤去済み" />
          </div>
          <label className="ui-field">
            <span>備考</span>
            <textarea className="ui-textarea" rows={2} value={form.note} onChange={set('note')} />
          </label>
          {error && <p className="ui-note is-danger">{error}</p>}
        </div>
        <div className="ui-modal-foot">
          <div className="ui-modal-foot-end">
            <button type="button" className="btn-plain" onClick={onClose}>
              キャンセル
            </button>
            <button type="button" className="btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? '保存中…' : meter ? '保存する' : '追加する'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
