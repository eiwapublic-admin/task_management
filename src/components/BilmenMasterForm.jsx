import { useState } from 'react'
import ConfirmDeleteButton from './ConfirmDeleteButton'
import Combobox from './Combobox'
import TimeInput from './TimeInput'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import {
  BILMEN_JURISDICTIONS,
  createBilmenMaster,
  updateBilmenMaster,
  deleteBilmenMaster,
  toTimeValue,
} from '../lib/bilmen'

// 作業マスタの追加・編集モーダル（docs/bilmen-plan.md 2-7・5-5）。
// 作業マスタID（master_no）は現行の値をそのまま継承するため手入力（自動採番しない。13-5）。
// 実施月は1〜12のチェックボックス、管轄は2値のラジオボタンにする（現行の詳細画面と同じ）。
const MONTH_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

export default function BilmenMasterForm({ existing, vendorOptions = [], onClose, onSaved, onDeleted }) {
  useBodyScrollLock()

  const [masterNo, setMasterNo] = useState(existing?.master_no != null ? String(existing.master_no) : '')
  const [title, setTitle] = useState(existing?.title || '')
  const [titleNote, setTitleNote] = useState(existing?.title_note || '')
  const [content, setContent] = useState(existing?.content || '')
  const [notice, setNotice] = useState(existing?.notice || '')
  const [place, setPlace] = useState(existing?.place || '')
  const [enterRoom, setEnterRoom] = useState(existing?.enter_room || false)
  const [notify, setNotify] = useState(existing?.notify || false)
  const [jurisdiction, setJurisdiction] = useState(existing?.jurisdiction || BILMEN_JURISDICTIONS[0])
  const [vendorCode, setVendorCode] = useState(existing?.vendor_code || '')
  const [vendorName, setVendorName] = useState(existing?.vendor_name || '')
  const [workerName, setWorkerName] = useState(existing?.worker_name || '')
  const [prepNote, setPrepNote] = useState(existing?.prep_note || '')
  const [planStart, setPlanStart] = useState(toTimeValue(existing?.plan_start))
  const [planEnd, setPlanEnd] = useState(toTimeValue(existing?.plan_end))
  const [months, setMonths] = useState(() => new Set(existing?.months || []))
  const [dayPattern, setDayPattern] = useState(existing?.day_pattern || '')
  const [cyclePattern, setCyclePattern] = useState(existing?.cycle_pattern || '')
  const [memo, setMemo] = useState(existing?.memo || '')
  const [remark, setRemark] = useState(existing?.remark || '')
  const [sortOrder, setSortOrder] = useState(existing?.sort_order != null ? String(existing.sort_order) : '999')
  const [disabled, setDisabled] = useState(existing?.disabled || false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function toggleMonth(m) {
    setMonths((prev) => {
      const next = new Set(prev)
      if (next.has(m)) next.delete(m)
      else next.add(m)
      return next
    })
  }

  async function handleSave() {
    setError('')
    if (!title.trim()) return setError('作業名は必須です')
    const no = Number(masterNo)
    if (!Number.isInteger(no) || no <= 0) return setError('作業マスタIDは1以上の整数で入力してください')

    setSaving(true)
    try {
      const payload = {
        master_no: no,
        title: title.trim(),
        title_note: titleNote,
        content,
        notice,
        place,
        enter_room: enterRoom,
        notify,
        jurisdiction,
        vendor_code: vendorCode,
        vendor_name: vendorName,
        worker_name: workerName,
        prep_note: prepNote,
        plan_start: planStart,
        plan_end: planEnd,
        months: [...months].sort((a, b) => a - b),
        day_pattern: dayPattern,
        cycle_pattern: cyclePattern,
        memo,
        remark,
        sort_order: Number(sortOrder) || 999,
        disabled,
      }
      const saved = existing ? await updateBilmenMaster(existing.id, payload) : await createBilmenMaster(payload)
      onSaved(saved)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  async function handleDelete() {
    try {
      await deleteBilmenMaster(existing.id)
      onDeleted(existing.id)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="ui-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="ui-modal is-sm" onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h3 className="ui-modal-title">{existing ? '作業マスタの編集' : '作業マスタを追加'}</h3>
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

          <div className="report-fields bilmen-halves">
            <label className="ui-field">
              <span>作業マスタID</span>
              <input
                type="number"
                className="ui-input"
                inputMode="numeric"
                value={masterNo}
                onChange={(e) => setMasterNo(e.target.value)}
              />
            </label>
            <label className="ui-field">
              <span>表示順</span>
              <input
                type="number"
                className="ui-input"
                inputMode="numeric"
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
              />
            </label>
          </div>

          <label className="ui-field">
            <span>作業名</span>
            <input type="text" className="ui-input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>

          <label className="ui-field">
            <span>作業の補足</span>
            <input
              type="text"
              className="ui-input"
              placeholder="連絡票で作業名の下に出る一文（電気保安定期点検・負荷設備保守 等）"
              value={titleNote}
              onChange={(e) => setTitleNote(e.target.value)}
            />
          </label>

          <fieldset className="bilmen-fieldset">
            <legend>実施月</legend>
            <div className="bilmen-month-grid">
              {MONTH_NUMBERS.map((m) => (
                <label key={m} className="bilmen-month-check">
                  <input type="checkbox" checked={months.has(m)} onChange={() => toggleMonth(m)} />
                  {m}
                </label>
              ))}
            </div>
            <p className="ui-note">すべて外すと「随時」（予定の自動作成の対象外）になります。</p>
          </fieldset>

          <div className="report-fields bilmen-halves">
            <label className="ui-field">
              <span>実施日パターン</span>
              <input
                type="text"
                className="ui-input"
                placeholder="月半ば 等"
                value={dayPattern}
                onChange={(e) => setDayPattern(e.target.value)}
              />
            </label>
            <label className="ui-field">
              <span>周期のメモ</span>
              <input
                type="text"
                className="ui-input"
                placeholder="3年に1回（2025年〜） 等"
                value={cyclePattern}
                onChange={(e) => setCyclePattern(e.target.value)}
              />
            </label>
          </div>

          <div className="report-fields bilmen-halves">
            <label className="ui-field">
              <span>予定開始時刻</span>
              <TimeInput className="ui-input" value={planStart} onChange={setPlanStart} />
            </label>
            <label className="ui-field">
              <span>予定終了時刻</span>
              <TimeInput className="ui-input" value={planEnd} onChange={setPlanEnd} />
            </label>
          </div>

          <fieldset className="bilmen-fieldset">
            <legend>管轄</legend>
            <div className="bilmen-radio-row">
              {BILMEN_JURISDICTIONS.map((j) => (
                <label key={j} className="bilmen-check-field">
                  <input
                    type="radio"
                    name="bilmen-master-jurisdiction"
                    checked={jurisdiction === j}
                    onChange={() => setJurisdiction(j)}
                  />
                  {j}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="report-fields bilmen-halves">
            <label className="ui-field">
              <span>担当会社コード</span>
              <input
                type="text"
                className="ui-input"
                placeholder="K-004 等"
                value={vendorCode}
                onChange={(e) => setVendorCode(e.target.value)}
              />
            </label>
            <label className="ui-field">
              <span>担当会社名</span>
              <Combobox value={vendorName} onChange={setVendorName} options={vendorOptions} placeholder="セコム 等" />
            </label>
          </div>

          <label className="ui-field">
            <span>実施業者名</span>
            <input
              type="text"
              className="ui-input"
              placeholder="担当会社の下請け等"
              value={workerName}
              onChange={(e) => setWorkerName(e.target.value)}
            />
          </label>

          <label className="ui-field">
            <span>作業場所</span>
            <input
              type="text"
              className="ui-input"
              placeholder="各テナント / 地下 / 玄関 等"
              value={place}
              onChange={(e) => setPlace(e.target.value)}
            />
          </label>

          <label className="ui-field">
            <span>作業内容</span>
            <textarea className="ui-textarea" rows={2} value={content} onChange={(e) => setContent(e.target.value)} />
          </label>

          <label className="ui-field">
            <span>注意事項（告知）</span>
            <textarea
              className="ui-textarea"
              rows={3}
              placeholder="連絡票の「(4) 留意事項」に出る。テナント様への申し送り事項"
              value={notice}
              onChange={(e) => setNotice(e.target.value)}
            />
          </label>

          <label className="bilmen-check-field">
            <input type="checkbox" checked={enterRoom} onChange={(e) => setEnterRoom(e.target.checked)} />
            入室作業（日程表の「入室あり*」に ✓ が付く）
          </label>
          <label className="bilmen-check-field">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            報知対象（掲示物・案内メールに載せる）
          </label>

          <label className="ui-field">
            <span>管理側作業・準備</span>
            <textarea className="ui-textarea" rows={2} value={prepNote} onChange={(e) => setPrepNote(e.target.value)} />
          </label>

          <label className="ui-field">
            <span>管理メモ（社内専用）</span>
            <textarea className="ui-textarea" rows={2} value={memo} onChange={(e) => setMemo(e.target.value)} />
          </label>

          <label className="ui-field">
            <span>備考</span>
            <textarea className="ui-textarea" rows={2} value={remark} onChange={(e) => setRemark(e.target.value)} />
          </label>

          <label className="bilmen-check-field">
            <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
            無効にする（自動作成の候補に出さない。過去の予定はそのまま残る）
          </label>
        </div>

        <div className="ui-modal-foot">
          <div className="ui-modal-foot-start">
            {existing && <ConfirmDeleteButton onConfirm={handleDelete} label="この作業マスタを削除" size={22} />}
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
