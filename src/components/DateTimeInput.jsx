import TimeInput from './TimeInput'

// ネイティブ <input type="datetime-local"> の代わりに、日付欄（<input type="date">）と
// 時刻欄（TimeInput）を横並びにした複合部品（2026-08-19）。
// 出庫・入庫フォームで datetime-local がモバイル（実機のSafari/WebKit）で右にはみ出す
// 不具合が、この環境のPlaywright（Chromium）では再現できずCSSの調整だけでは直らなかった
// ため、はみ出しの原因となるネイティブ部品自体を使わない構成に変更した。
// value/onChange は既存の datetime-local と同じ 'YYYY-MM-DDTHH:MM' 文字列（toDateTimeLocal()の
// 出力形式）を使うので、呼び出し側の state・保存処理は変更せずに差し替えられる。
export default function DateTimeInput({ value, onChange, disabled }) {
  const [datePart, timePart] = (value || '').split('T')

  function handleDateChange(e) {
    const nextDate = e.target.value
    if (!nextDate) return
    onChange(`${nextDate}T${timePart || '00:00'}`)
  }

  function handleTimeChange(nextTime) {
    if (!datePart) return
    onChange(`${datePart}T${nextTime || '00:00'}`)
  }

  return (
    <div className="ui-field-row">
      <input
        type="date"
        className="ui-input"
        value={datePart || ''}
        disabled={disabled}
        onChange={handleDateChange}
        aria-label="日付"
      />
      <TimeInput className="ui-input" value={timePart || ''} disabled={disabled} onChange={handleTimeChange} aria-label="時刻" />
    </div>
  )
}
