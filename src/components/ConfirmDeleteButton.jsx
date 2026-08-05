import { useState } from 'react'
import { IconTrash } from './Icons'

// 削除ボタン。押しただけでは削除せず、確認（削除／キャンセル）を挟んでから実行する
// （タスク詳細の「スパム」確認と同じ考え方。誤操作でレコードが消えるのを防ぐ）。
export default function ConfirmDeleteButton({ onConfirm, label = 'この記録を削除', size = 18 }) {
  const [confirming, setConfirming] = useState(false)

  if (confirming) {
    return (
      <span className="confirm-delete-group" role="group" aria-label="削除の確認">
        <span className="confirm-delete-message">削除しますか？</span>
        <button
          type="button"
          className="confirm-delete-go"
          onClick={() => {
            setConfirming(false)
            onConfirm()
          }}
        >
          削除
        </button>
        <button type="button" className="confirm-delete-cancel" onClick={() => setConfirming(false)}>
          キャンセル
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      className="icon-btn-delete"
      onClick={() => setConfirming(true)}
      aria-label={label}
      title="削除"
    >
      <IconTrash size={size} />
    </button>
  )
}
