import { authFetch } from './api'

// 業務マニュアル（日常業務の手引書。2026-10-13〜）の API 呼び出しと、種類ごとの項目定義。
// 種類と項目は worker/lib/manuals.js の MANUAL_FIELDS と揃えること。

export const MANUAL_KINDS = [
  { key: 'response', label: '対応マニュアル', titleLabel: '依頼・問い合わせ例' },
  { key: 'routine', label: '定例作業', titleLabel: '作業名' },
  { key: 'procedure', label: '関連手順', titleLabel: '手順名' },
]

export const MANUAL_KIND_LABELS = Object.fromEntries(MANUAL_KINDS.map((k) => [k.key, k.label]))

// 画面に出す順の項目。procedure は本文（body）だけ
export const MANUAL_FIELD_DEFS = {
  response: [
    { key: 'method', label: '対応方法' },
    { key: 'contact', label: '連絡先' },
    { key: 'note', label: '留意事項' },
  ],
  routine: [
    { key: 'timing', label: 'タイミング' },
    { key: 'items', label: '持ち物・準備' },
    { key: 'place', label: '作業場所' },
    { key: 'content', label: '作業内容' },
    { key: 'after', label: '事後' },
    { key: 'remark', label: '備考' },
  ],
  procedure: [],
}

// キーワード検索の対象になる文字列（項目名・各項目・本文をつないだもの）
export function manualSearchText(m) {
  return [m.title, ...Object.values(m.fields || {}), m.body || ''].join('\n').toLowerCase()
}

export async function fetchManuals() {
  const data = await authFetch('/api/manuals')
  return data.manuals || []
}

export async function createManual(payload) {
  const data = await authFetch('/api/manuals', { method: 'POST', body: JSON.stringify(payload) })
  return data.manual
}

export async function updateManual(id, payload) {
  const data = await authFetch('/api/manuals', { method: 'PATCH', body: JSON.stringify({ id, ...payload }) })
  return data.manual
}

export async function deleteManual(id) {
  await authFetch(`/api/manuals?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}
