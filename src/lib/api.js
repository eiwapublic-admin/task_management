import { getToken, logout } from './auth'

// Worker の API（/api/*）への認証付きリクエスト用ヘルパー。
export async function authFetch(path, options = {}) {
  const token = getToken()
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  })

  // 認証切れ（トークン期限切れ等）。UI 上はログイン中でもサーバー側で 401 になる。
  // 混乱を招く「認証が必要です」で行き止まりにせず、セッションを破棄してログイン画面へ誘導する。
  if (res.status === 401) {
    logout()
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.assign('/login?expired=1')
    }
    throw new Error('セッションの有効期限が切れました。再度ログインしてください。')
  }

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `リクエストに失敗しました (${res.status})`)
  }
  return data
}

// メールの手動取得を実行する（/api/run-fetch）。取得・分類の集計を返す。
export function runFetch() {
  return authFetch('/api/run-fetch', { method: 'POST' })
}

// 設定を保存する（/api/settings）。
export function saveSettings(values) {
  return authFetch('/api/settings', { method: 'PUT', body: JSON.stringify(values) })
}

// タスクを手動で新規登録する（/api/tasks）。作成したタスクを返す。
export function createTask(values) {
  return authFetch('/api/tasks', { method: 'POST', body: JSON.stringify(values) })
}

// タスクの担当者・期限・留意事項などを更新する（/api/tasks）。更新後のタスクを返す。
export function updateTask(id, values) {
  return authFetch('/api/tasks', { method: 'PATCH', body: JSON.stringify({ id, ...values }) })
}

// スレッド内の全メッセージの添付ファイル一覧（メタ情報）を取得する（/api/attachments）。
// 返信で本文が上書きされても最初・途中の添付が失われないよう、スレッド単位で集約して取得する。
// { attachments: [{ filename, mimeType, size, attachmentId, messageId }, ...] } を返す。
export function listAttachments(threadId) {
  return authFetch(`/api/attachments?thread_id=${encodeURIComponent(threadId)}`)
}

// 添付ファイルを Gmail から取得してブラウザに保存させる（/api/attachment）。
// バイナリを扱うため authFetch は使わず、取得した Blob をダウンロードとして起動する。
// thread_id はタスク所属の検証に使う（サーバー側で thread_id がタスクに
// 紐づくこと・message_id がそのスレッドに実在することを確認する）。
export async function downloadAttachment({ threadId, messageId, attachmentId, filename, mimeType }) {
  const token = getToken()
  const params = new URLSearchParams({
    thread_id: threadId,
    message_id: messageId,
    attachment_id: attachmentId,
    filename: filename || 'attachment',
    mime: mimeType || 'application/octet-stream',
  })
  const res = await fetch(`/api/attachment?${params.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })

  // 認証切れは他の API と同様に扱い、ログイン画面へ誘導する
  if (res.status === 401) {
    logout()
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.assign('/login?expired=1')
    }
    throw new Error('セッションの有効期限が切れました。再度ログインしてください。')
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `ダウンロードに失敗しました (${res.status})`)
  }

  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename || 'attachment'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
