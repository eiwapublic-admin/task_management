import { useEffect } from 'react'

// 「このシステムについて」: システム構成図（public/system-overview.png）を表示するだけの
// シンプルなモーダル。タスク詳細のような編集要素は無いため、フォーカストラップ等は行わず
// Escape・オーバーレイクリック・×ボタンでの close だけを提供する。
export default function AboutModal({ open, onClose }) {
  useEffect(() => {
    if (!open) return
    function handleKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="about-modal-overlay" onClick={onClose}>
      <div
        className="about-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="about-modal-header">
          <h2 id="about-modal-title">このシステムについて</h2>
          <button className="task-detail-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>
        <img
          className="about-modal-image"
          src="/system-overview.png"
          alt="システム構成図: Gmail・Google カレンダーからタスク管理システムへ、AIが情報を整理して取り込む流れ"
        />
      </div>
    </div>
  )
}
