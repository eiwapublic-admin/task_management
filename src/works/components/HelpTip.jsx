// 見出しの横の「?」。押す（PC はマウスを乗せる）と説明を吹き出しで出す（2026-11-25 依頼元の要望）。
//   表は横スクロールの枠の中にあり、枠の外にはみ出す吹き出しが切れるので、body に fixed で出す
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export default function HelpTip({ text, label = '説明' }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)
  const [pinned, setPinned] = useState(false)
  const show = () => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const width = Math.min(280, window.innerWidth - 16)
    const left = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8))
    setPos({ top: r.bottom + 6, left, width })
  }
  const hide = () => {
    setPos(null)
    setPinned(false)
  }
  useEffect(() => {
    if (!pos) return
    const close = (e) => {
      if (ref.current?.contains(e.target)) return
      hide()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [pos])
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="works-help"
        aria-label={label}
        aria-expanded={!!pos}
        onClick={(e) => {
          e.stopPropagation()
          if (pinned) hide()
          else {
            show()
            setPinned(true)
          }
        }}
        onMouseEnter={show}
        onMouseLeave={() => !pinned && setPos(null)}
      >
        ?
      </button>
      {pos &&
        createPortal(
          <div className="works-help-pop" role="tooltip" style={{ top: pos.top, left: pos.left, width: pos.width }}>
            {text}
          </div>,
          document.body
        )}
    </>
  )
}
