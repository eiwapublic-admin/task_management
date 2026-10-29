import { authFetch } from './api'
import { BILMEN_BUILDING_NAME } from './bilmen'

// テナントへのメール（雛型からの一斉メール。2026-10-29〜）の API 呼び出しと変数展開。
// サーバー側は worker/lib/tenant-mail.js。宛先・返信先・その他の宛先は src/lib/bilmen.js の
// fetchBilmenMailRecipients・fetchBilmenMailSettings 等をそのまま使う（ビルメンの案内メールと共通）。

export async function fetchTenantMailTemplates() {
  const data = await authFetch('/api/tenant-mail/templates')
  return data.templates || []
}

export async function createTenantMailTemplate(payload) {
  const data = await authFetch('/api/tenant-mail/templates', { method: 'POST', body: JSON.stringify(payload) })
  return data.template
}

export async function updateTenantMailTemplate(id, payload) {
  const data = await authFetch('/api/tenant-mail/templates', { method: 'PATCH', body: JSON.stringify({ id, ...payload }) })
  return data.template
}

export async function deleteTenantMailTemplate(id) {
  await authFetch(`/api/tenant-mail/templates?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// Gmail の下書きを作る（添付なし。送信はしない）。宛先・返信先はサーバーがDBから引き直す
export async function createTenantMailDraft({ templateId, subject, body }) {
  return authFetch('/api/tenant-mail/draft', {
    method: 'POST',
    body: JSON.stringify({ template_id: templateId, subject, body }),
  })
}

// 一般の雛型で使える変数。ビルメンの雛型は従来どおり %対象年月%・%建物名%・%作業件数%
// （src/lib/bilmen.js の expandMailVariables）
export const TENANT_MAIL_VARIABLES = [
  { key: '%建物名%', note: BILMEN_BUILDING_NAME },
  { key: '%今日%', note: '例: 2026年10月29日' },
  { key: '%今月%', note: '例: 2026年10月' },
  { key: '%来月%', note: '例: 2026年11月' },
]

export function expandTenantMailVariables(text, now = new Date()) {
  const y = now.getFullYear()
  const m = now.getMonth() + 1
  const next = new Date(y, m, 1)
  return (text || '')
    .replaceAll('%建物名%', BILMEN_BUILDING_NAME)
    .replaceAll('%今日%', `${y}年${m}月${now.getDate()}日`)
    .replaceAll('%今月%', `${y}年${m}月`)
    .replaceAll('%来月%', `${next.getFullYear()}年${next.getMonth() + 1}月`)
}
