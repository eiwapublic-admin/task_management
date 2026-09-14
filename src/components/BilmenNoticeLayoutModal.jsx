import { useState } from 'react'
import useBodyScrollLock from '../lib/useBodyScrollLock'
import { NOTICE_LAYOUTS, loadNoticeLayout, saveNoticeLayout } from '../lib/bilmen'

// 連絡票PDFの版を選ぶモーダル（2026-09-14〜）。従来版とカード版は載せる情報が
// 同じで見た目だけが違うため、月の件数・留意事項の長さに応じて選べるようにした。
// 選んだ版は次回の既定として localStorage に覚えさせる（lib/bilmen.js）。
export default function BilmenNoticeLayoutModal({ month, count, onClose, onSelect }) {
  useBodyScrollLock()

  const [layout, setLayout] = useState(loadNoticeLayout)

  function handleSubmit() {
    saveNoticeLayout(layout)
    onSelect(layout)
  }

  return (
    <div className="ui-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="ui-modal is-sm" onClick={(e) => e.stopPropagation()}>
        <div className="ui-modal-head">
          <h3 className="ui-modal-title">連絡票の版を選ぶ</h3>
          <button type="button" className="icon-btn-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>

        <div className="ui-modal-body">
          <p className="ui-note">
            {month.replace('-', '年')}月度・報知対象 {count} 件。どちらの版も載せる内容は同じです。
            選んだ版は次回の既定になります。
          </p>

          <div className="bilmen-layout-choices">
            {Object.entries(NOTICE_LAYOUTS).map(([key, conf]) => (
              <label key={key} className={`bilmen-layout-choice${layout === key ? ' is-selected' : ''}`}>
                <input
                  type="radio"
                  name="bilmen-notice-layout"
                  value={key}
                  checked={layout === key}
                  onChange={() => setLayout(key)}
                />
                <span className="bilmen-layout-text">
                  <span className="bilmen-layout-label">{conf.label}</span>
                  <span className="bilmen-layout-desc">{conf.description}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="ui-modal-foot">
          <div className="ui-modal-foot-end">
            <button type="button" className="btn-plain" onClick={onClose}>
              キャンセル
            </button>
            <button type="button" className="btn-primary" onClick={handleSubmit}>
              この版で作成
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
