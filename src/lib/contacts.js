import { authFetch } from './api'

// 連絡帳（顧客の連絡先台帳。2026-08-31〜）の API 呼び出しをまとめる。

export async function fetchContacts() {
  const data = await authFetch('/api/contacts')
  return data.contacts || []
}

export async function createContact(payload) {
  const data = await authFetch('/api/contacts', { method: 'POST', body: JSON.stringify(payload) })
  return data.contact
}

export async function updateContact(id, patch) {
  const data = await authFetch('/api/contacts', { method: 'PATCH', body: JSON.stringify({ id, ...patch }) })
  return data.contact
}

export async function deleteContact(id) {
  await authFetch(`/api/contacts?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function fetchContactCategories() {
  const data = await authFetch('/api/contacts/suggest')
  return data.values || []
}

// タスク・メールの取得実績から連絡帳を自動作成する（既存の連絡先は上書きしない）。
// { created, skipped } を返す
export async function syncContactsFromTasks() {
  return authFetch('/api/contacts/sync', { method: 'POST' })
}

// 新規メール作成用の mailto: リンクを組み立てる。TOに加え、登録されたCC（定例で付ける先）を
// 自動で付与する。返信ではなく新規作成のため、件名・本文は入れない
export function buildContactMailto(contact) {
  if (!contact?.email_to) return null
  const params = new URLSearchParams()
  if (contact.email_cc) params.set('cc', contact.email_cc)
  const query = params.toString()
  return `mailto:${encodeURIComponent(contact.email_to)}${query ? `?${query}` : ''}`
}
