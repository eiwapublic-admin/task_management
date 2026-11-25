// eWorks の編集用モーダル（共通部品 .ui-overlay / .ui-modal で組む）
//   「保存」など画面全体のボタンは、スクロールしないフッタに置く（2026-11-20 依頼元の共通ルール）。
//   本文の中の部品からは <ModalFoot> で包むと、フッタに表示される。
//   特定の欄に対するボタン（「＋ 例外の休憩を追加」など）は例外で、その欄のそばに置く。
import { createContext, useContext, useState } from 'react'
import { createPortal } from 'react-dom'

const FootContext = createContext(null)

export function ModalFoot({ children }) {
  const el = useContext(FootContext)
  return el ? createPortal(children, el) : null
}

// headExtra: 見出しの右（閉じるの左）に置くボタンなど（例: 日の詳細の「休暇を申請する」）
export default function Modal({ title, onClose, children, foot, headExtra = null, size = 'sm' }) {
  const [footEl, setFootEl] = useState(null)
  return (
    <div className="ui-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`ui-modal is-${size}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="ui-modal-head">
          <h2 className="ui-modal-title">{title}</h2>
          {headExtra && <div className="works-modal-head-extra">{headExtra}</div>}
          <button type="button" className="icon-btn-close" aria-label="閉じる" onClick={onClose}>×</button>
        </div>
        <FootContext.Provider value={footEl}>
          <div className="ui-modal-body is-stacked">{children}</div>
        </FootContext.Provider>
        <div className="ui-modal-foot works-modal-foot" ref={setFootEl}>{foot}</div>
      </div>
    </div>
  )
}
