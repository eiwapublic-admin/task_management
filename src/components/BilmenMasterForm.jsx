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

export default function BilmenMasterForm({
  existing,
  vendorOptions = [],
  // メンテナンス予定の詳細から「マスタの定義を見る」で別タブとして開かれた場合だけ true。
  // 戻り道（タブを閉じる）を出すために使う（2026-09-14）
  openedAsJumpTab = false,
  onClose,
  onSaved,
  onDeleted,
}) {
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
  const [cycleYears, setCycleYears] = useState(existing?.cycle_years != null ? String(existing.cycle_years) : '')
  const [cycleAnchorYear, setCycleAnchorYear] = useState(
    existing?.cycle_anchor_year != null ? String(existing.cycle_anchor_year) : '',
  )
  const [memo, setMemo] = useState(existing?.memo || '')
  const [remark, setRemark] = useState(existing?.remark || '')
  const [sortOrder, setSortOrder] = useState(existing?.sort_order != null ? String(existing.sort_order) : '999')
  const [disabled, setDisabled] = useState(existing?.disabled || false)
  const [saving, setSaving] = useState(false)
  // 入力の誤りは state に溜めず毎回の描画で作り直し、直したその場で消えるようにする
  // （2026-09-15。周期の片方だけ入れて保存→もう片方を入れても、以前は保存を押し直すまで
  //   エラーが残り「両方入れているのにエラーが出る」ように見えていた）。
  // submitted は「一度でも保存を押したか」で、押す前から赤字を出さないための目印。
  // サーバー由来のエラーだけは次に保存を押すまで消さずに出しておく
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState('')
  const [closeTabFailed, setCloseTabFailed] = useState(false)

  // 別タブで開かれたときの戻り道（2026-09-14）。ホーム画面に追加したアプリから
  // 「マスタの定義を見る」を押すとアプリの外の Safari で開くため、タブバーも戻るボタンも
  // 無く元の画面に戻れなくなる。スクリプトで開かれたタブは window.close() で閉じられるので、
  // 閉じれば直前の画面（予定の詳細）に戻る。
  // 直接URLを開いた場合などブラウザが拒否することもあるため、閉じられなかったときは
  // 手動で戻る案内を出す（close() が成功していればこのタブ自体が消えるので表示されない）
  function handleCloseTab() {
    window.close()
    setTimeout(() => setCloseTabFailed(true), 300)
  }

  // 入力した周期で実際にどの年が対象になるかを出す（5-3-1）。起点より前は出さず、
  // 今年（または起点）以降の直近4回ぶんだけ並べる。入力が揃っていなければ空文字
  const cyclePreview = (() => {
    const years = Number(cycleYears)
    const anchor = Number(cycleAnchorYear)
    if (!Number.isInteger(years) || years < 2 || years > 50) return ''
    if (!Number.isInteger(anchor) || anchor < 1900 || anchor > 2200) return ''
    const thisYear = new Date().getFullYear()
    // 今年以降で最初に来る実施年から数える（起点が未来ならその起点から）
    const start = anchor >= thisYear ? anchor : anchor + Math.ceil((thisYear - anchor) / years) * years
    return Array.from({ length: 4 }, (_, i) => `${start + i * years}年`).join('・')
  })()

  // 入力の誤りを1つだけ返す（無ければ空文字）。描画のたびに評価する
  function validate() {
    if (!title.trim()) return '作業名は必須です'
    const no = Number(masterNo)
    if (!Number.isInteger(no) || no <= 0) return '作業マスタIDは1以上の整数で入力してください'

    // 周期は「◯年に1回」と「起点の年」がセットで初めて判定できる（5-3-1）。
    // 片方だけだと黙って毎年扱いになってしまうため、ここで気づけるようにする
    const { years, anchor } = cycleValues()
    if ((years === null) !== (anchor === null)) {
      return '周期は「何年に1回」と「起点の年」の両方を入力してください（毎年の作業は両方とも空欄）'
    }
    if (years !== null && (!Number.isInteger(years) || years < 2 || years > 50)) {
      return '周期の「何年に1回」は2〜50の整数で入力してください'
    }
    if (anchor !== null && (!Number.isInteger(anchor) || anchor < 1900 || anchor > 2200)) {
      return '周期の「起点の年」は1900〜2200の範囲で入力してください'
    }
    return ''
  }

  function cycleValues() {
    return {
      years: cycleYears.trim() ? Number(cycleYears) : null,
      anchor: cycleAnchorYear.trim() ? Number(cycleAnchorYear) : null,
    }
  }

  const validationError = validate()
  const shownError = serverError || (submitted ? validationError : '')

  // ×・オーバーレイクリックでの閉じ方も、別タブで開かれている場合はタブごと閉じる
  // （モーダルだけ閉じてもマスタ一覧が残るだけで、元の画面には戻れないため）
  const handleDismiss = openedAsJumpTab ? handleCloseTab : onClose

  function toggleMonth(m) {
    setMonths((prev) => {
      const next = new Set(prev)
      if (next.has(m)) next.delete(m)
      else next.add(m)
      return next
    })
  }

  async function handleSave() {
    setSubmitted(true)
    setServerError('')
    if (validationError) return

    const { years, anchor } = cycleValues()
    setSaving(true)
    try {
      const payload = {
        master_no: Number(masterNo),
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
        cycle_years: years,
        cycle_anchor_year: anchor,
        memo,
        remark,
        sort_order: Number(sortOrder) || 999,
        disabled,
      }
      const saved = existing ? await updateBilmenMaster(existing.id, payload) : await createBilmenMaster(payload)
      onSaved(saved)
      // 別タブで開かれている場合は、保存したらそのまま閉じて元の画面へ戻す
      // （閉じないとマスタ一覧だけが残った行き止まりのタブになるため）
      if (openedAsJumpTab) handleCloseTab()
    } catch (err) {
      setServerError(err.message)
      setSaving(false)
    }
  }

  async function handleDelete() {
    try {
      await deleteBilmenMaster(existing.id)
      onDeleted(existing.id)
      if (openedAsJumpTab) handleCloseTab()
    } catch (err) {
      setServerError(err.message)
    }
  }

  return (
    <div className="ui-overlay" role="dialog" aria-modal="true" onClick={handleDismiss}>
      <div className="ui-modal is-sm" onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h3 className="ui-modal-title">{existing ? '作業マスタの編集' : '作業マスタを追加'}</h3>
          <button type="button" className="icon-btn-close" onClick={handleDismiss} aria-label="閉じる">
            ×
          </button>
        </div>

        <div className="ui-modal-body is-stacked">
          {openedAsJumpTab && (
            <p className="ui-note bilmen-jump-note">
              メンテナンス予定から開きました。確認・編集が済んだら
              <strong>「閉じて予定に戻る」</strong>で元の画面に戻れます。
            </p>
          )}

          {closeTabFailed && (
            <p className="dashboard-banner" role="status">
              このタブは自動で閉じられませんでした。お手数ですが、ブラウザのタブ一覧から
              元の画面（メンテナンス予定）に戻ってください。
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

          {/* 数年に1回の作業の周期（5-3-1。2026-09-15〜）。ここを入れておくと、予定の自動作成が
              実施年でない年を自動で外してくれる（従来は「周期のメモ」を人が読んで判断していた） */}
          <fieldset className="bilmen-fieldset">
            <legend>周期（毎年でない作業）</legend>
            <div className="report-fields bilmen-halves">
              <label className="ui-field">
                <span>何年に1回</span>
                <input
                  type="number"
                  className="ui-input"
                  inputMode="numeric"
                  min="2"
                  max="50"
                  placeholder="2"
                  value={cycleYears}
                  onChange={(e) => setCycleYears(e.target.value)}
                />
              </label>
              <label className="ui-field">
                <span>起点の年（実施した年）</span>
                <input
                  type="number"
                  className="ui-input"
                  inputMode="numeric"
                  min="1900"
                  max="2200"
                  placeholder="2025"
                  value={cycleAnchorYear}
                  onChange={(e) => setCycleAnchorYear(e.target.value)}
                />
              </label>
            </div>
            <p className="ui-note">
              {cyclePreview
                ? `${cyclePreview} が実施年になります（以降も同じ間隔で続きます）。`
                : '毎年実施する作業は両方とも空欄にしてください。例: 「2年に1回・奇数年」なら 2 と 2025。'}
            </p>
            <label className="ui-field">
              <span>周期のメモ（人向け。判定には使いません）</span>
              <input
                type="text"
                className="ui-input"
                placeholder="２年に１回（奇数年） 等"
                value={cyclePattern}
                onChange={(e) => setCyclePattern(e.target.value)}
              />
            </label>
          </fieldset>

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
            入室作業（日程表の「入室*」に ✓ が付く）
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

        {/* エラーは本文の外（スクロールしない位置）に出す。縦に長いフォームでは
            本文の先頭に置くと、下の方を編集している間は画面外に隠れて気づけない（2026-09-15） */}
        {shownError && (
          <p className="ui-modal-alert" role="alert">
            {shownError}
          </p>
        )}

        <div className="ui-modal-foot">
          <div className="ui-modal-foot-start">
            {existing && <ConfirmDeleteButton onConfirm={handleDelete} label="この作業マスタを削除" size={22} />}
          </div>
          <div className="ui-modal-foot-end">
            {openedAsJumpTab ? (
              <button type="button" className="btn-plain" onClick={handleCloseTab}>
                閉じて予定に戻る
              </button>
            ) : (
              <button type="button" className="btn-plain" onClick={onClose}>
                キャンセル
              </button>
            )}
            <button type="button" className="btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? '保存中…' : '保存する'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
