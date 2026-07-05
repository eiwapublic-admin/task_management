const TOKEN_KEY = 'task_management_token'
const USER_KEY = 'task_management_user'

export async function login(username, password) {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })

  const data = await res.json()

  if (!res.ok) {
    throw new Error(data.error || 'ログインに失敗しました')
  }

  localStorage.setItem(TOKEN_KEY, data.token)
  localStorage.setItem(USER_KEY, JSON.stringify(data.user))

  return data.user
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY)
}

export function getCurrentUser() {
  const raw = localStorage.getItem(USER_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// JWTのペイロードをデコードして有効期限(exp)を取り出す。
// ※これはクライアント側の利便性チェック（期限切れなら自動ログアウト）であり、
//   セキュリティ上の検証ではない。署名検証は必ずサーバー側で行うこと。
function tokenExpiry(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

export function isAuthenticated() {
  const token = getToken()
  if (!token) return false
  const expiresAt = tokenExpiry(token)
  if (expiresAt !== null && Date.now() >= expiresAt) {
    logout()
    return false
  }
  return true
}
