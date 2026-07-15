import { useEffect, useRef, useState } from 'react'
import { STATUS_LIST, UNASSIGNED } from '../lib/status'
import { formatDateTime } from '../lib/format'
import { gmailMessageUrl, buildReplyMailto } from '../lib/mail'
import { listAttachments, downloadAttachment } from '../lib/api'

// バイト数を読みやすい単位にする
function formatBytes(n) {
  if (!n || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export default function TaskDetail({ task, onClose, onStatusChange, sharedGmail, assignees = [], onUpdateTask }) {
  const modalRef = useRef(null)
  const previouslyFocused = useRef(null)

  // 編集用のローカル状態（担当者・期限・留意事項）
  const [assignee, setAssignee] = useState(UNASSIGNED)
  const [dueDate, setDueDate] = useState('')
  const [remarks, setRemarks] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saved, setSaved] = useState(false)

  // 添付ファイル（元メールから都度取得）
  const [attachments, setAttachments] = useState([])
  const [attLoading, setAttLoading] = useState(false)
  const [attError, setAttError] = useState('')
  const [downloadingId, setDownloadingId] = useState('')
  const [downloadError, setDownloadError] = useState('')

  // 対象タスクが切り替わったら編集フォームを初期化する
  useEffect(() => {
    if (!task) return
    setAssignee(task.assignee || UNASSIGNED)
    setDueDate(task.due_date || '')
    setRemarks(task.remarks || '')
    setSaveError('')
    setSaved(false)
  }, [task])

  // メール由来のタスクは、開いたときに元メールの添付ファイル一覧を取得する
  useEffect(() => {
    setAttachments([])
    setAttError('')
    setDownloadError('')
    setDownloadingId('')
    // スレッド全体の添付を集約して取得する。返信で本文が上書きされても、
    // 最初・途中の返信に添付されたファイルが失われず表示されるようにするため。
    if (!task || task.source !== 'email' || !task.gmail_thread_id) {
      setAttLoading(false)
      return
    }
    let cancelled = false
    setAttLoading(true)
    listAttachments(task.gmail_thread_id)
      .then((res) => {
        if (!cancelled) setAttachments(res.attachments || [])
      })
      .catch((err) => {
        if (!cancelled) setAttError(err.message || '添付ファイルの確認に失敗しました')
      })
      .finally(() => {
        if (!cancelled) setAttLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [task])

  useEffect(() => {
    if (!task) return

    previouslyFocused.current = document.activeElement
    // 背景のスクロールを止める
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    // 開いたらモーダル内にフォーカスを移す
    modalRef.current?.querySelector('.task-detail-close')?.focus()

    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      // 簡易フォーカストラップ: モーダル内の操作可能要素だけを循環させる
      const focusables = modalRef.current?.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      if (!focusables || focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = prevOverflow
      // 閉じたら元の要素へフォーカスを戻す
      previouslyFocused.current?.focus?.()
    }
  }, [task, onClose])

  if (!task) return null

  // カレンダー由来・手動登録のタスクにはメール参照・返信は無い
  const isEmail = task.source === 'email'
  const mailUrl = isEmail ? gmailMessageUrl(task, sharedGmail) : null
  const replyHref = isEmail ? buildReplyMailto(task) : null
  const isUnassigned = assignee === UNASSIGNED

  // 担当者の選択肢（既存の担当者一覧 + 未設定 + 現在値の取りこぼし防止）
  const assigneeOptions = Array.from(new Set([UNASSIGNED, ...assignees, task.assignee].filter(Boolean)))

  const dirty =
    assignee !== (task.assignee || UNASSIGNED) ||
    dueDate !== (task.due_date || '') ||
    remarks !== (task.remarks || '')

  async function handleSave() {
    if (!onUpdateTask || !dirty) return
    setSaving(true)
    setSaveError('')
    setSaved(false)
    try {
      await onUpdateTask(task.id, {
        assignee,
        due_date: dueDate || null,
        remarks: remarks.trim() || null,
      })
      setSaved(true)
    } catch (err) {
      setSaveError(err.message || '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  async function handleDownload(att) {
    setDownloadingId(att.attachmentId)
    setDownloadError('')
    try {
      await downloadAttachment({
        messageId: att.messageId || task.gmail_message_id,
        attachmentId: att.attachmentId,
        filename: att.filename,
        mimeType: att.mimeType,
      })
    } catch (err) {
      setDownloadError(err.message || 'ダウンロードに失敗しました')
    } finally {
      setDownloadingId('')
    }
  }

  const hasAttachments = attachments.length > 0

  return (
    <div className="task-detail-overlay" onClick={onClose}>
      <div
        className="task-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-detail-title"
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="task-detail-header">
          <h2 id="task-detail-title">
            {task.title}
            {hasAttachments && (
              <span className="task-detail-attach-badge" title="添付ファイルあり" aria-label="添付ファイルあり">
                📎 添付あり
              </span>
            )}
          </h2>
          <button className="task-detail-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>
        <dl className="task-detail-fields">
          <dt>担当者</dt>
          <dd>
            <select
              className={`task-detail-input${isUnassigned ? ' is-unassigned' : ''}`}
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
            >
              {assigneeOptions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            {isUnassigned && <span className="task-detail-warn">⚠ 担当者が未設定です</span>}
          </dd>
          <dt>ステータス</dt>
          <dd>{task.status}</dd>
          <dt>期限</dt>
          <dd>
            <input
              type="date"
              className="task-detail-input"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </dd>
          <dt>受信日時</dt>
          <dd>{formatDateTime(task.received_at) ?? '不明'}</dd>
          <dt>送信者</dt>
          <dd>{task.sender}</dd>
          <dt>件名</dt>
          <dd>{task.subject}</dd>
          {isEmail && (
            <>
              <dt>添付ファイル</dt>
              <dd>
                {attLoading && <span className="task-detail-attach-muted">確認中…</span>}
                {!attLoading && attError && (
                  <span className="task-detail-attach-error">{attError}</span>
                )}
                {!attLoading && !attError && !hasAttachments && (
                  <span className="task-detail-attach-muted">なし</span>
                )}
                {!attLoading && hasAttachments && (
                  <ul className="task-detail-attachments">
                    {attachments.map((att) => (
                      <li key={`${att.messageId || ''}-${att.attachmentId}`} className="task-detail-attachment">
                        <span className="task-detail-attachment-icon" aria-hidden="true">
                          📎
                        </span>
                        <span className="task-detail-attachment-name">{att.filename}</span>
                        {att.size > 0 && (
                          <span className="task-detail-attachment-size">
                            （{formatBytes(att.size)}）
                          </span>
                        )}
                        <button
                          type="button"
                          className="task-detail-attachment-download"
                          onClick={() => handleDownload(att)}
                          disabled={downloadingId === att.attachmentId}
                        >
                          {downloadingId === att.attachmentId ? '取得中…' : 'ダウンロード'}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {downloadError && (
                  <div className="task-detail-attach-error">{downloadError}</div>
                )}
              </dd>
            </>
          )}
          <dt>留意事項</dt>
          <dd>
            <textarea
              className="task-detail-input task-detail-remarks"
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              rows={3}
              placeholder="対応時に留意すべき事項があれば入力してください"
            />
          </dd>
          <dt>本文プレビュー</dt>
          <dd className="task-detail-body">{task.body_preview}</dd>
          {task.classification_note && (
            <>
              <dt>AI判定の理由</dt>
              <dd className="task-detail-note">{task.classification_note}</dd>
            </>
          )}
        </dl>

        <div className="task-detail-edit-bar">
          {saveError && <span className="task-detail-save-error">{saveError}</span>}
          {saved && !dirty && <span className="task-detail-save-ok">保存しました</span>}
          <button
            type="button"
            className="task-action-btn task-action-reply"
            onClick={handleSave}
            disabled={saving || !dirty}
          >
            {saving ? '保存中…' : '担当者・期限・留意事項を保存'}
          </button>
        </div>

        <div className="task-detail-footer">
          <span className="task-detail-footer-label">ステータス</span>
          <div className="task-detail-status" role="group" aria-label="ステータスを変更">
            {STATUS_LIST.map((status) => (
              <button
                key={status}
                className={status === task.status ? 'status-btn active' : 'status-btn'}
                aria-pressed={status === task.status}
                onClick={() => onStatusChange(task, status)}
              >
                {status}
              </button>
            ))}
          </div>
          <div className="task-detail-actions">
            {mailUrl && (
              <a className="task-action-btn" href={mailUrl} target="_blank" rel="noopener noreferrer">
                メール参照
              </a>
            )}
            {replyHref && (
              <a className="task-action-btn task-action-reply" href={replyHref}>
                返信
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
