// eWorks の編集用モーダル（共通部品 .ui-overlay / .ui-modal で組む）
export default function Modal({ title, onClose, children, foot, size = 'sm' }) {
  return (
    <div className="ui-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`ui-modal is-${size}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="ui-modal-head">
          <h2 className="ui-modal-title">{title}</h2>
          <button type="button" className="icon-btn-close" aria-label="閉じる" onClick={onClose}>×</button>
        </div>
        <div className="ui-modal-body is-stacked">{children}</div>
        {foot && <div className="ui-modal-foot">{foot}</div>}
      </div>
    </div>
  )
}
