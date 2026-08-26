import { useEffect, useMemo, useRef, useState } from 'react'

// テキスト入力＋候補の絞り込み選択（5-4・5-8等で使う「既存データから選ぶ、または新規入力」）。
// <input list> + <datalist> は Safari（iOS/iPadOS）で候補が正しく出ない・キーボードの上に
// 数件だけ表示される等、実機で動作が大きく崩れることが分かったため使わない（2026-08-12）。
// 代わりに、自前の候補リストをテキスト入力の下に描画する素朴な組み合わせ欄にする。
//
// options: 文字列の配列、または { key, label } の配列（key で選択を通知したいとき）。
// onSelect は候補をタップして選んだときだけ呼ばれる（自由入力との区別が要る場面向け。任意）
export default function Combobox({ value, onChange, onSelect, options, placeholder, className = '', disabled = false }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  const normalized = useMemo(
    () => options.map((o) => (typeof o === 'string' ? { key: o, label: o } : o)),
    [options]
  )
  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase()
    const list = q ? normalized.filter((o) => o.label.toLowerCase().includes(q)) : normalized
    // 上限20件だと備品テナント（現在32件）等、候補が多い一覧で後方（階の大きいテナント等）が
    // 一切選べなくなっていた（2026-08-26）。候補欄自体が max-height:240px + overflow-y:auto で
    // スクロールする作りのため、件数を増やしても表示は崩れない。実用上十分な上限として200件にする
    return list.slice(0, 200)
  }, [value, normalized])

  useEffect(() => {
    if (!open) return
    function onPointerDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  function pick(opt) {
    onChange(opt.label)
    onSelect?.(opt.key, opt.label)
    setOpen(false)
  }

  // ×ボタン: 一旦文字を入れると候補が絞り込まれて選び直しにくくなるため、
  // ワンタップで空にして候補リストを全件表示し直せるようにする（2026-08-12）
  function clear() {
    onChange('')
    setOpen(true)
  }

  return (
    <div className={`ui-combobox ${className}`} ref={wrapRef}>
      <input
        type="text"
        className="ui-input"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
      />
      {value && !disabled && (
        <button
          type="button"
          className="ui-combobox-clear"
          onMouseDown={(e) => e.preventDefault()}
          onClick={clear}
          aria-label="入力をクリア"
        >
          ×
        </button>
      )}
      {open && !disabled && filtered.length > 0 && (
        <ul className="ui-combobox-list">
          {filtered.map((opt) => (
            <li key={opt.key}>
              {/* onMouseDown で preventDefault し、input の blur より先にタップを確定させる */}
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(opt)}>
                {opt.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
