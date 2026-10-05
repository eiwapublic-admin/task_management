import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

// テキスト入力＋候補の絞り込み選択（5-4・5-8等で使う「既存データから選ぶ、または新規入力」）。
// <input list> + <datalist> は Safari（iOS/iPadOS）で候補が正しく出ない・キーボードの上に
// 数件だけ表示される等、実機で動作が大きく崩れることが分かったため使わない（2026-08-12）。
// 代わりに、自前の候補リストをテキスト入力の下に描画する素朴な組み合わせ欄にする。
//
// options: 文字列の配列、または { key, label } の配列（key で選択を通知したいとき）。
// onSelect は候補をタップして選んだときだけ呼ばれる（自由入力との区別が要る場面向け。任意）
//
// 候補リストは入力欄の下に開くが、下に十分な余白が無いとき（モーダルの下端・フッターの直前など）は
// 上に開く（2026-10-05。備品の出庫モーダルで「設置場所」の候補がフッターの下に隠れていた）。
// 余白は「一番近いスクロール領域（無ければ画面）」の内側で測り、リストの高さもその余白に収める

const LIST_MAX = 240 // .ui-combobox-list の既定の max-height と同じ
const LIST_GAP = 8

// 要素を切り取ってしまう一番近い祖先（overflow が visible 以外）の表示範囲。無ければ画面
function clipRectOf(el) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p)
    if (overflowY !== 'visible') return p.getBoundingClientRect()
  }
  return { top: 0, bottom: window.innerHeight }
}
export default function Combobox({ value, onChange, onSelect, options, placeholder, className = '', disabled = false }) {
  const [open, setOpen] = useState(false)
  // 候補リストを上下どちらに・どの高さで開くか
  const [placement, setPlacement] = useState({ up: false, maxHeight: LIST_MAX })
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

  const showList = open && !disabled && filtered.length > 0

  // 開くたびに、下の余白が足りるかを測って向きと高さを決める（描画前に決めてちらつかせない）
  useLayoutEffect(() => {
    if (!showList || !wrapRef.current) return
    const input = wrapRef.current.getBoundingClientRect()
    const clip = clipRectOf(wrapRef.current)
    const below = clip.bottom - input.bottom - LIST_GAP
    const above = input.top - clip.top - LIST_GAP
    const up = below < Math.min(LIST_MAX, 160) && above > below
    const maxHeight = Math.max(80, Math.min(LIST_MAX, up ? above : below))
    setPlacement((prev) => (prev.up === up && prev.maxHeight === maxHeight ? prev : { up, maxHeight }))
  }, [showList])

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
      {showList && (
        <ul className={`ui-combobox-list${placement.up ? ' is-up' : ''}`} style={{ maxHeight: placement.maxHeight }}>
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
