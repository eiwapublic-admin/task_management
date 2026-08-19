import { useState } from 'react'

// テンキーで4桁を入力して時刻を確定する入力欄（2026-08-19）。
// モバイルのネイティブ <input type="time"> はダイアル式で時・分を選ぶ操作が
// 面倒との依頼を受け、数字（例:"0913"）を入力してフィールドを離れると
// "9:13" と解釈する方式に置き換えた。value/onChange の型は既存の
// <input type="time"> と同じ 'HH:MM' 文字列（空なら ''）にしてあるので、
// 呼び出し側の state・保存処理は変更せずに差し替えられる。
//
// 入力の解釈: 末尾2桁を分、それより前を時として扱う（3桁以下は先頭を0埋め）。
// 例: "0913"→9:13 / "913"→9:13 / "5"→0:05。時23・分59を超えたら不正として
// フィールドを離れるタイミングでエラー表示にする（保存はしない）。
//
// editingText が null の間は value プロパティをそのまま表示に使い、フォーカス中だけ
// ローカルの編集バッファ（数字のみの文字列）に切り替える。こうすることで、
// 保存失敗時のロールバック等で親から value が書き換わった場合も、編集中でなければ
// 自動的に最新の表示へ追従する（stateの二重管理によるズレを避けるための実装方針）。
export default function TimeInput({ value, onChange, className, disabled, placeholder = '--:--', ...rest }) {
  const [editingText, setEditingText] = useState(null)
  const [invalid, setInvalid] = useState(false)

  const displayValue = editingText !== null ? editingText : value || ''

  function handleFocus() {
    setInvalid(false)
    setEditingText((value || '').replace(':', ''))
  }

  function handleChange(e) {
    setEditingText(e.target.value.replace(/\D/g, '').slice(0, 4))
    setInvalid(false)
  }

  function commit() {
    const text = editingText ?? ''
    if (text === '') {
      setEditingText(null)
      setInvalid(false)
      if (value) onChange('')
      return
    }
    const padded = text.padStart(4, '0')
    const hh = Number(padded.slice(0, 2))
    const mm = Number(padded.slice(2, 4))
    if (hh > 23 || mm > 59) {
      setInvalid(true)
      return
    }
    const formatted = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
    setInvalid(false)
    setEditingText(null)
    if (formatted !== value) onChange(formatted)
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      className={`${className || ''}${invalid ? ' is-invalid' : ''}`}
      value={displayValue}
      disabled={disabled}
      placeholder={placeholder}
      aria-invalid={invalid || undefined}
      onFocus={handleFocus}
      onChange={handleChange}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
      {...rest}
    />
  )
}
