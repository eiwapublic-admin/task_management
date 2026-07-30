import { useState } from 'react'
import { formatDate, formatDateTime, assigneeColor, assigneeInitial, dueStatus } from '../lib/format'
import { STATUS_DONE, UNASSIGNED } from '../lib/status'
import { channelIconSrc, channelLabel } from '../lib/channel'
import { formatTaskId } from '../lib/taskId'

// カードに表示する発信元の名前。先方（顧客＝タスクのオーナー）の宛名 contact を最優先で表示する。
// 自社発信・フォーム経由のタスクは sender_display が自社担当者になるため、contact があればそれを使う。
// contact が無ければ sender_display、それも無ければ From ヘッダーの表示名にフォールバックする。
function senderLabel(task) {
  if (task.contact) return task.contact
  if (task.sender_display) return task.sender_display
  const from = task.sender || ''
  const name = from.replace(/<[^>]*>/g, '').replace(/["']/g, '').trim()
  return name || from.trim() || null
}

// 取得・更新から24時間以内かどうか（新着マーク表示用）。
// updated_at は登録時・自動更新（返信検知等）・手動編集のいずれでも更新されるため、
// 「取得または更新から24時間以内」の判定にそのまま使える。
const NEW_BADGE_MS = 24 * 60 * 60 * 1000
function isRecentlyUpdated(task) {
  if (!task.updated_at) return false
  const updatedAt = new Date(task.updated_at).getTime()
  if (Number.isNaN(updatedAt)) return false
  return Date.now() - updatedAt < NEW_BADGE_MS
}

export default function TaskCard({ task, onDragStart, onClick, onSpam }) {
  const due = dueStatus(task.due_date)
  const isUnassigned = task.assignee === UNASSIGNED
  const isNew = isRecentlyUpdated(task)
  const isDone = task.status === STATUS_DONE
  // スパムボタンは押し間違いでタスクが視界から消えるため、カード内で確認を挟む
  const [confirmingSpam, setConfirmingSpam] = useState(false)

  function handleKeyDown(e) {
    // カード全体をキーボードで開けるようにする（Enter / Space）
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick(task)
    }
  }

  // 確認UI内のクリックはカード全体（詳細を開く）へ伝播させない
  function stop(e) {
    e.stopPropagation()
  }

  return (
    <div
      className={`task-card${isDone ? ' is-done' : ''}`}
      draggable
      role="button"
      tabIndex={0}
      aria-label={`${formatTaskId(task)} ${task.title} / 担当 ${task.assignee}`}
      onDragStart={(e) => onDragStart(e, task)}
      onClick={() => onClick(task)}
      onKeyDown={handleKeyDown}
    >
      {isNew && (
        <span className="task-card-new-badge" title="24時間以内に取得・更新されました">
          新着
        </span>
      )}
      <div className="task-card-title">
        <img
          className="task-card-channel-icon"
          src={channelIconSrc(task)}
          alt={channelLabel(task)}
          title={channelLabel(task)}
        />
        {task.title}
      </div>

      {/* タスクID: 依頼・問い合わせの際にタスクを特定するための短い連番 */}
      {formatTaskId(task) && <div className="task-card-task-id">{formatTaskId(task)}</div>}

      {senderLabel(task) && <div className="task-card-sender">{senderLabel(task)}</div>}

      <div className="task-card-meta">
        <span className={`task-card-assignee${isUnassigned ? ' is-unassigned' : ''}`}>
          <span
            className="avatar"
            style={{ background: isUnassigned ? 'var(--due-soon)' : assigneeColor(task.assignee) }}
            aria-hidden="true"
          >
            {isUnassigned ? '!' : assigneeInitial(task.assignee)}
          </span>
          {task.assignee}
        </span>
        {task.due_date && (
          <span className={`task-card-due${due?.level ? ` due-${due.level}` : ''}`}>
            期限: {formatDate(task.due_date)}
          </span>
        )}
      </div>

      {due?.label && <div className={`task-card-due-flag due-${due.level}`}>{due.label}</div>}

      <div className="task-card-received">受信: {formatDateTime(task.received_at)}</div>

      {task.remarks && <div className="task-card-remarks">{task.remarks}</div>}

      {/* スパム判定。誤操作でタスクが視界から消えないよう、その場で確認を挟む。
          「移動」でスパムフラグを立てて完了＋アーカイブへ移し、アーカイブ画面へ遷移する。 */}
      {onSpam && (
        <div className="task-card-spam" onClick={stop} onKeyDown={stop}>
          {confirmingSpam ? (
            <div className="task-card-spam-confirm" role="group" aria-label="スパム判定の確認">
              <span className="task-card-spam-message">
                スパムと判定してすぐにアーカイブへ移動します。
              </span>
              <span className="task-card-spam-actions">
                <button
                  type="button"
                  className="task-card-spam-go"
                  onClick={() => {
                    setConfirmingSpam(false)
                    onSpam(task)
                  }}
                >
                  移動
                </button>
                <button
                  type="button"
                  className="task-card-spam-cancel"
                  onClick={() => setConfirmingSpam(false)}
                >
                  キャンセル
                </button>
              </span>
            </div>
          ) : (
            <button
              type="button"
              className="task-card-spam-btn"
              onClick={() => setConfirmingSpam(true)}
              aria-label={`${task.title} をスパムと判定`}
            >
              スパム
            </button>
          )}
        </div>
      )}
    </div>
  )
}
