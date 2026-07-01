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
  return raw ? JSON.parse(raw) : null
}

export function isAuthenticated() {
  return Boolean(getToken())
}
