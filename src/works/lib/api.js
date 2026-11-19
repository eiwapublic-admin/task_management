// eWorks の API 呼び出しとログイン状態。
// トークンはタスク管理（task_management_token）とは別のキーに保存する（アプリごとに 1 回ログイン）。
const TOKEN_KEY = 'eworks_token'
const USER_KEY = 'eworks_user'

export function getToken() {
  return localStorage.getItem(TOKEN_KEY)
}

export function getUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null')
  } catch {
    return null
  }
}

export function saveSession({ token, user }) {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USER_KEY, JSON.stringify(user))
}

export function setUser(user) {
  localStorage.setItem(USER_KEY, JSON.stringify(user))
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

// クライアント側の利便性チェック（期限切れなら自動ログアウト）。署名検証はサーバー側
export function isLoggedIn() {
  const token = getToken()
  if (!token) return false
  try {
    const { exp } = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    if (typeof exp === 'number' && Date.now() >= exp * 1000) {
      logout()
      return false
    }
  } catch {
    return false
  }
  return true
}

export async function api(path, { method = 'GET', body, auth = true } = {}) {
  const token = getToken()
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 401 && auth) {
    logout()
    if (!window.location.pathname.startsWith('/login')) window.location.assign('/login?expired=1')
    throw new Error('ログインの有効期限が切れました。もう一度ログインしてください')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || data.message || `処理に失敗しました（${res.status}）`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

export async function login(username, password) {
  const data = await api('/api/works/login', { method: 'POST', body: { username, password }, auth: false })
  saveSession(data)
  return data.user
}

export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']
export const STATUS_LABEL = { active: '在籍', leave: '休職', retired: '退職' }

export function hhmm(t) {
  return t ? String(t).slice(0, 5) : ''
}
