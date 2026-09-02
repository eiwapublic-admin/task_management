import { useState } from 'react'
import ConfirmDeleteButton from './ConfirmDeleteButton'
import Combobox from './Combobox'
import TimeInput from './TimeInput'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import {
  BILMEN_JURISDICTIONS,
  createBilmenSchedule,
  updateBilmenSchedule,
  deleteBilmenSchedule,
  formatMonths,
  toTimeValue,
} from '../lib/bilmen'

// メンテナンス予定の詳細モーダル（docs/bilmen-plan.md 2-2・5-2）。
// 現行の2カラム構成（左＝予定・右＝実績）を踏襲する。iPhone 幅では Bilmen.css 側で
// 1カラムに縦積みになる（予定 → 実績の順）。
//
// 予定はマスタの「コピー」なので、ここで編集した内容はマスタに戻さない（3-2）。
// 作業ID（work_no）は手入力・空欄可で、保存時にサーバー側の unique 制約で重複を弾く（13-5）。
//
// Google カレンダー反映（7-2）は Phase 3 で追加する。反映済みの日時だけは
// 参照できるよう、値が入っているときに限り表示する。
export default function BilmenScheduleForm({ existing, month, masters = [], vendorOptions = [], onClose, onSaved, onDeleted }) {
  useBodyScrollLock()

  const [workNo, setWorkNo] = useState(existing?.work_no || '')
  const [masterId, setMasterId] = useState(existing?.master_id || '')
  const [targetMonth, setTargetMonth] = useState(existing?.target_month || month || '')
  const [planDate, setPlanDate] = useState(existing?.plan_date || '')
  const [planStart, setPlanStart] = useState(toTimeValue(existing?.plan_start))
  const [planEnd, setPlanEnd] = useState(toTimeValue(existing?.plan_end))
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
  const [memo, setMemo] = useState(existing?.memo || '')
  const [remark, setRemark] = useState(existing?.remark || '')
  const [actualDate, setActualDate] = useState(existing?.actual_date || '')
  const [actualStart, setActualStart] = useState(toTimeValue(existing?.actual_start))
  const [actualEnd, setActualEnd] = useState(toTimeValue(existing?.actual_end))
  const [actualNote, setActualNote] = useState(existing?.actual_note || '')
  const [reportConfirmedOn, setReportConfirmedOn] = useState(existing?.report_confirmed_on || '')
  const [canceled, setCanceled] = useState(existing?.canceled || false)
  const [cancelReason, setCancelReason] = useState(existing?.cancel_reason || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const selectedMaster = masters.find((m) => m.id === masterId) || null

  // 新規追加時にマスタを選んだら、その内容を予定へ複写する（3-2。以後は予定側で自由に直せる）
  function applyMaster(id) {
    setMasterId(id)
    const m = masters.find((x) => x.id === id)
    if (!m) return
    setTitle(m.title || '')
    setTitleNote(m.title_note || '')
    setContent(m.content || '')
    setNotice(m.notice || '')
    setPlace(m.place || '')
    setEnterRoom(m.enter_room || false)
    setNotify(m.notify || false)
    setJurisdiction(m.jurisdiction || BILMEN_JURISDICTIONS[0])
    setVendorCode(m.vendor_code || '')
    setVendorName(m.vendor_name || '')
    setWorkerName(m.worker_name || '')
    setPrepNote(m.prep_note || '')
    setRemark(m.remark || '')
    setPlanStart(toTimeValue(m.plan_start))
    setPlanEnd(toTimeValue(m.plan_end))
  }

  // 「予定通り ➡」。予定の日付・時刻をそのまま実績へ写す（2-1・2-2）
  function copyPlanToActual() {
    if (!planDate) {
      setError('予定日付が未入力のため実績へ写せません')
      return
    }
    setError('')
    setActualDate(planDate)
    setActualStart(planStart)
    setActualEnd(planEnd)
  }

  // 予定日付を変えたら対象年月も追従させる（一覧の月グループとずれないように）
  function handlePlanDateChange(value) {
    setPlanDate(value)
    if (value) setTargetMonth(value.slice(0, 7))
  }

  async function handleSave() {
    setError('')
    if (!title.trim()) return setError('作業名は必須です')
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(targetMonth)) return setError('対象年月を選んでください')
    if (canceled && !cancelReason.trim()) return setError('中止にする場合は中止理由を入力してください')

    setSaving(true)
    try {
      const payload = {
        full: true,
        work_no: workNo,
        master_id: masterId || null,
        target_month: targetMonth,
        plan_date: planDate,
        plan_start: planStart,
        plan_end: planEnd,
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
        remark,
        memo,
        actual_date: actualDate,
        actual_start: actualStart,
        actual_end: actualEnd,
        actual_note: actualNote,
        report_confirmed_on: reportConfirmedOn,
        canceled,
        cancel_reason: cancelReason,
        sort_order: existing?.sort_order ?? 999,
      }
      const saved = existing
        ? await updateBilmenSchedule(existing.id, payload)
        : await createBilmenSchedule(payload)
      onSaved(saved)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  async function handleDelete() {
    try {
      await deleteBilmenSchedule(existing.id)
      onDeleted(existing.id)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="ui-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="ui-modal is-lg" onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h3 className="ui-modal-title">{existing ? 'メンテナンス予定' : 'メンテナンス予定を追加'}</h3>
          <button type="button" className="icon-btn-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>

        <div className="ui-modal-body">
          {error && (
            <p className="dashboard-error dashboard-banner" role="alert">
              {error}
            </p>
          )}

          <div className="bilmen-detail-head">
            <label className="ui-field">
              <span>作業ID</span>
              <input
                type="text"
                className="ui-input"
                placeholder="W260901-27（空欄のまま保存し、後から入れられます）"
                value={workNo}
                onChange={(e) => setWorkNo(e.target.value)}
              />
            </label>
            <label className="ui-field">
              <span>作業マスタ</span>
              <select className="ui-select" value={masterId} onChange={(e) => applyMaster(e.target.value)}>
                <option value="">（マスタに紐付けない）</option>
                {masters.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.master_no}: {m.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="ui-field">
              <span>対象年月</span>
              <input
                type="month"
                className="ui-input"
                value={targetMonth}
                onChange={(e) => setTargetMonth(e.target.value)}
              />
            </label>
          </div>
          {selectedMaster && (
            <p className="ui-note">マスタの実施月: {formatMonths(selectedMaster.months)}</p>
          )}

          <div className="bilmen-detail-cols">
            {/* ---- 左: 予定 ---- */}
            <section className="ui-card bilmen-detail-col">
              <h4 className="ui-card-title">予定</h4>

              <label className="ui-field">
                <span>予定日付</span>
                <input
                  type="date"
                  className="ui-input"
                  value={planDate}
                  onChange={(e) => handlePlanDateChange(e.target.value)}
                />
              </label>

              <div className="report-fields bilmen-halves">
                <label className="ui-field">
                  <span>開始</span>
                  <TimeInput className="ui-input" value={planStart} onChange={setPlanStart} />
                </label>
                <label className="ui-field">
                  <span>終了</span>
                  <TimeInput className="ui-input" value={planEnd} onChange={setPlanEnd} />
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
                  value={titleNote}
                  onChange={(e) => setTitleNote(e.target.value)}
                />
              </label>

              <label className="ui-field">
                <span>補足（作業内容）</span>
                <textarea
                  className="ui-textarea"
                  rows={2}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                />
              </label>

              <label className="ui-field">
                <span>注意事項（告知）</span>
                <textarea
                  className="ui-textarea"
                  rows={3}
                  placeholder="連絡票の「(4) 留意事項」に出る"
                  value={notice}
                  onChange={(e) => setNotice(e.target.value)}
                />
              </label>

              <label className="ui-field">
                <span>作業場所</span>
                <input type="text" className="ui-input" value={place} onChange={(e) => setPlace(e.target.value)} />
              </label>

              <label className="bilmen-check-field">
                <input type="checkbox" checked={enterRoom} onChange={(e) => setEnterRoom(e.target.checked)} />
                入室作業
              </label>
              <label className="bilmen-check-field">
                <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
                報知対象（掲示物・案内メールに載せる）
              </label>

              <label className="ui-field">
                <span>管理メモ（社内専用）</span>
                <textarea
                  className="ui-textarea"
                  rows={2}
                  placeholder="9/3から9/4に変更されました 等"
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                />
              </label>

              <fieldset className="bilmen-fieldset">
                <legend>管轄</legend>
                <div className="bilmen-radio-row">
                  {BILMEN_JURISDICTIONS.map((j) => (
                    <label key={j} className="bilmen-check-field">
                      <input
                        type="radio"
                        name="bilmen-schedule-jurisdiction"
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
                    value={vendorCode}
                    onChange={(e) => setVendorCode(e.target.value)}
                  />
                </label>
                <label className="ui-field">
                  <span>担当会社名</span>
                  <Combobox value={vendorName} onChange={setVendorName} options={vendorOptions} />
                </label>
              </div>

              <label className="ui-field">
                <span>実施業者名</span>
                <input
                  type="text"
                  className="ui-input"
                  value={workerName}
                  onChange={(e) => setWorkerName(e.target.value)}
                />
              </label>

              <label className="ui-field">
                <span>管理側作業・準備</span>
                <textarea
                  className="ui-textarea"
                  rows={2}
                  value={prepNote}
                  onChange={(e) => setPrepNote(e.target.value)}
                />
              </label>

              {existing?.google_synced_at && (
                <p className="ui-note">
                  Google カレンダー反映: {new Date(existing.google_synced_at).toLocaleString('ja-JP')}
                </p>
              )}
            </section>

            {/* ---- 右: 実績 ---- */}
            <section className="ui-card bilmen-detail-col">
              <h4 className="ui-card-title">
                実績
                <button type="button" className="btn-plain ui-card-title-action" onClick={copyPlanToActual}>
                  予定通り ➡
                </button>
              </h4>

              <label className="ui-field">
                <span>実績日付</span>
                <input
                  type="date"
                  className="ui-input"
                  value={actualDate}
                  onChange={(e) => setActualDate(e.target.value)}
                />
              </label>

              <div className="report-fields bilmen-halves">
                <label className="ui-field">
                  <span>開始</span>
                  <TimeInput className="ui-input" value={actualStart} onChange={setActualStart} />
                </label>
                <label className="ui-field">
                  <span>終了</span>
                  <TimeInput className="ui-input" value={actualEnd} onChange={setActualEnd} />
                </label>
              </div>

              <label className="ui-field">
                <span>作業実績報告事項</span>
                <textarea
                  className="ui-textarea"
                  rows={4}
                  value={actualNote}
                  onChange={(e) => setActualNote(e.target.value)}
                />
              </label>

              <label className="ui-field">
                <span>報告書確認日付</span>
                <input
                  type="date"
                  className="ui-input"
                  value={reportConfirmedOn}
                  onChange={(e) => setReportConfirmedOn(e.target.value)}
                />
              </label>

              <label className="bilmen-check-field">
                <input type="checkbox" checked={canceled} onChange={(e) => setCanceled(e.target.checked)} />
                中止
              </label>
              {canceled && (
                <label className="ui-field">
                  <span>中止理由</span>
                  <textarea
                    className="ui-textarea"
                    rows={2}
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                  />
                </label>
              )}

              <label className="ui-field">
                <span>備考</span>
                <textarea className="ui-textarea" rows={2} value={remark} onChange={(e) => setRemark(e.target.value)} />
              </label>

              {/* 実施報告書ファイルは Phase 5（既存の添付UIを流用）で追加する */}
            </section>
          </div>
        </div>

        <div className="ui-modal-foot">
          <div className="ui-modal-foot-start">
            {existing && <ConfirmDeleteButton onConfirm={handleDelete} label="この予定を削除" size={22} />}
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
