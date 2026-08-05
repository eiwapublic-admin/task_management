import { useEffect, useRef, useState } from 'react'
import { STATUS_LIST, UNASSIGNED } from '../lib/status'
import { formatDateTime } from '../lib/format'
import { gmailMessageUrl, buildReplyMailto } from '../lib/mail'
import { listAttachments, downloadAttachment, fetchAttachmentBlob, getAttachmentPreviewUrl } from '../lib/api'
import { channelIconSrc, channelLabel } from '../lib/channel'
import { formatTaskId } from '../lib/taskId'
import AttachmentPreview from './AttachmentPreview'

// アプリ内プレビューに対応する形式（画像・PDF）。それ以外はダウンロードのみ。
function isPreviewable(mimeType) {
  return (mimeType || '').startsWith('image/') || mimeType === 'application/pdf'
}

// バイト数を読みやすい単位にする
function formatBytes(n) {
  if (!n || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export default function TaskDetail({ task, onClose, onStatusChange, sharedGmail, assignees = [], onUpdateTask, onUnspam, onSpam, onAddToReport }) {
  const modalRef = useRef(null)
  const previouslyFocused = useRef(null)
  // プレビューが開いている間はタスク詳細側のEscape/Tab処理を無効化する
  // （refで管理し、下のkeydownハンドラのクロージャが常に最新値を参照できるようにする）
  const previewOpenRef = useRef(false)
  // 現在のプレビューのBlob URL。effectの依存配列に入れると添付一覧の再取得
  // effectまで再実行されてしまうため、stateとは別にrefでも保持して参照する。
  const previewUrlRef = useRef('')

  // 編集用のローカル状態（担当者・期限・留意事項）
  const [assignee, setAssignee] = useState(UNASSIGNED)
  const [dueDate, setDueDate] = useState('')
  const [remarks, setRemarks] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saved, setSaved] = useState(false)
  // スパム判定の確認表示（押し間違いでタスクがアーカイブへ消えるのを防ぐ）
  const [confirmingSpam, setConfirmingSpam] = useState(false)
  // 「日報に追加」の処理中表示・エラー
  const [addingToReport, setAddingToReport] = useState(false)
  const [addReportError, setAddReportError] = useState('')

  // 添付ファイル（元メールから都度取得）
  const [attachments, setAttachments] = useState([])
  const [attLoading, setAttLoading] = useState(false)
  const [attError, setAttError] = useState('')
  const [downloadingId, setDownloadingId] = useState('')
  const [downloadError, setDownloadError] = useState('')

  // アプリ内プレビュー（画像・PDF）。Blob URL はモーダルを閉じる際に解放する。
  const [previewAtt, setPreviewAtt] = useState(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [previewingId, setPreviewingId] = useState('')

  // 対象タスクが切り替わったら編集フォームを初期化する
  useEffect(() => {
    if (!task) return
    setAssignee(task.assignee || UNASSIGNED)
    setDueDate(task.due_date || '')
    setRemarks(task.remarks || '')
    setSaveError('')
    setSaved(false)
    setConfirmingSpam(false)
    setAddReportError('')
  }, [task])

  // メール由来のタスクは、開いたときに元メールの添付ファイル一覧を取得する
  useEffect(() => {
    setAttachments([])
    setAttError('')
    setDownloadError('')
    setDownloadingId('')
    // タスクが切り替わったら開いていたプレビューも閉じる（Blob URLなら解放。
    // PDFの直接URLはBlobではないため revokeObjectURL の対象外）
    previewOpenRef.current = false
    if (previewUrlRef.current?.startsWith('blob:')) URL.revokeObjectURL(previewUrlRef.current)
    previewUrlRef.current = ''
    setPreviewAtt(null)
    setPreviewUrl('')
    setPreviewingId('')
    // スレッド全体の添付を集約して取得する。返信で本文が上書きされても、
    // 最初・途中の返信に添付されたファイルが失われず表示されるようにするため。
    if (!task || task.source !== 'email' || !task.gmail_thread_id) {
      setAttLoading(false)
      return
    }
    let cancelled = false
    setAttLoading(true)
    listAttachments(task.gmail_thread_id, task.gmail_message_id)
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
      // プレビューモーダルが開いている間は、その独自のEscapeハンドラに任せる
      if (previewOpenRef.current) return
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

  // 送信者の右隣に出す発信元の宛名。contact（AI 抽出の敬称付き宛名）を優先し、
  // 無ければ sender_display に「様」を付けて補う（contact 生成前の既存タスク向け）。
  const contactLabel = task.contact || (task.sender_display ? `${task.sender_display} 様` : null)

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
        threadId: task.gmail_thread_id,
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

  // 画像・PDFをアプリ内でプレビュー表示する（さっと内容を確認したい用途）。
  // 画像はBlob URLで表示するが、PDFはBlob URLだとSafariのiframeで正しく描画
  // できないことがあるため、短時間有効な直接URL（getAttachmentPreviewUrl）へ
  // ナビゲーションする方式にする（Blobではないため閉じる際に解放は不要）。
  async function handlePreview(att) {
    setPreviewingId(att.attachmentId)
    setDownloadError('')
    try {
      const isPdf = att.mimeType === 'application/pdf'
      const url = isPdf
        ? await getAttachmentPreviewUrl({
            threadId: task.gmail_thread_id,
            messageId: att.messageId || task.gmail_message_id,
            attachmentId: att.attachmentId,
            filename: att.filename,
            mimeType: att.mimeType,
          })
        : URL.createObjectURL(
            await fetchAttachmentBlob({
              threadId: task.gmail_thread_id,
              messageId: att.messageId || task.gmail_message_id,
              attachmentId: att.attachmentId,
              filename: att.filename,
              mimeType: att.mimeType,
            })
          )
      previewOpenRef.current = true
      previewUrlRef.current = url
      setPreviewAtt(att)
      setPreviewUrl(url)
    } catch (err) {
      setDownloadError(err.message || 'プレビューの取得に失敗しました')
    } finally {
      setPreviewingId('')
    }
  }

  // 「日報に追加」。当日の日報の作業記録として、タスクのタイトルを内容に転記する。
  // 実際の作成・遷移は呼び出し元（Dashboard/Archive）に任せる。
  async function handleAddToReport() {
    if (!onAddToReport || addingToReport) return
    setAddingToReport(true)
    setAddReportError('')
    try {
      await onAddToReport(task)
    } catch (err) {
      setAddReportError(err.message || '日報への追加に失敗しました')
      setAddingToReport(false)
    }
  }

  function closePreview() {
    previewOpenRef.current = false
    if (previewUrlRef.current?.startsWith('blob:')) URL.revokeObjectURL(previewUrlRef.current)
    previewUrlRef.current = ''
    setPreviewAtt(null)
    setPreviewUrl('')
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
            <img
              className="task-detail-channel-icon"
              src={channelIconSrc(task)}
              alt={channelLabel(task)}
              title={channelLabel(task)}
            />
            {/* タスクID: 問い合わせ・調査依頼の際にこのタスクを一意に指せるようにする */}
            {formatTaskId(task) && (
              <span className="task-detail-task-id" title="タスクID（問い合わせ時にご利用ください）">
                {formatTaskId(task)}
              </span>
            )}
            {task.title}
            {hasAttachments && (
              <span className="task-detail-attach-badge" title="添付ファイルあり" aria-label="添付ファイルあり">
                📎 添付あり
              </span>
            )}
            {/* スパム判定済みの表示と解除。アーカイブ画面の一覧は横に長く、
                モバイルでは操作列まで届きにくいため、詳細からも解除できるようにする */}
            {task.is_spam && (
              <span className="task-detail-spam-badge">
                スパム
                {onUnspam && (
                  <button
                    type="button"
                    className="task-detail-spam-clear"
                    onClick={() => onUnspam(task)}
                  >
                    解除
                  </button>
                )}
              </span>
            )}
          </h2>
          <button className="task-detail-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>
        {/* 1行目: 担当者・期限・受信日時を横並び（ステータスはフッタにあるため省略） */}
        <div className="task-detail-toprow">
          <div className="task-detail-topitem">
            <span className="task-detail-topitem-label">担当者</span>
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
            {isUnassigned && <span className="task-detail-warn">⚠ 未設定</span>}
          </div>
          <div className="task-detail-topitem">
            <span className="task-detail-topitem-label">期限</span>
            <input
              type="date"
              className="task-detail-input"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
          {/* 受信日時は「2026/07/29 08:20 受信」と後置きにして、1行目（担当者・期限・
              スパム・保存）に収まる幅にする（2026-07-31。従来は「受信日時 ○○」の前置き） */}
          <div className="task-detail-topitem">
            <span>{formatDateTime(task.received_at) ?? '不明'}</span>
            <span className="task-detail-topitem-label">受信</span>
          </div>
          <div className="task-detail-save-group">
            {saveError && <span className="task-detail-save-error">{saveError}</span>}
            {saved && !dirty && <span className="task-detail-save-ok">保存しました</span>}
            {/* スパム判定は保存ボタンの左。誤操作でタスクが視界から消えるため確認を挟む。
                アーカイブ済み・スパム済みのタスクには出さない（解除はタイトル横のバッジから）。 */}
            {onSpam && !task.is_spam && !task.archived_at && (
              confirmingSpam ? (
                <span className="task-detail-spam-confirm" role="group" aria-label="スパム判定の確認">
                  <span className="task-detail-spam-message">
                    スパムと判定してすぐにアーカイブへ移動します。
                  </span>
                  <button
                    type="button"
                    className="task-detail-spam-go"
                    onClick={() => {
                      setConfirmingSpam(false)
                      onSpam(task)
                    }}
                  >
                    移動
                  </button>
                  <button
                    type="button"
                    className="task-detail-spam-cancel"
                    onClick={() => setConfirmingSpam(false)}
                  >
                    キャンセル
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="task-detail-spam-btn"
                  onClick={() => setConfirmingSpam(true)}
                >
                  スパム
                </button>
              )
            )}
            <button
              type="button"
              className="task-action-btn task-action-reply"
              onClick={handleSave}
              disabled={saving || !dirty}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>

        <dl className="task-detail-fields">
          <dt>送信者</dt>
          <dd>
            {task.sender}
            {contactLabel && <span className="task-detail-contact">{contactLabel}</span>}
          </dd>
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
                        {isPreviewable(att.mimeType) && (
                          <button
                            type="button"
                            className="task-detail-attachment-preview"
                            onClick={() => handlePreview(att)}
                            disabled={previewingId === att.attachmentId}
                          >
                            {previewingId === att.attachmentId ? '取得中…' : 'プレビュー'}
                          </button>
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
            {addReportError && <span className="task-detail-save-error">{addReportError}</span>}
            {onAddToReport && (
              <button
                type="button"
                className="task-action-btn"
                onClick={handleAddToReport}
                disabled={addingToReport}
              >
                {addingToReport ? '追加中…' : '日報に追加'}
              </button>
            )}
            {mailUrl && (
              <a className="task-action-btn" href={mailUrl} target="_blank" rel="noopener noreferrer">
                メール参照
              </a>
            )}
            {replyHref && (
              <a className="task-action-btn task-action-dark" href={replyHref}>
                返信
              </a>
            )}
          </div>
        </div>
      </div>
      <AttachmentPreview attachment={previewAtt} url={previewUrl} onClose={closePreview} />
    </div>
  )
}
